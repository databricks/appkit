import { randomUUID } from "node:crypto";
import type express from "express";
import type {
  AgentToolDefinition,
  IAppRouter,
  StreamExecutionSettings,
  ToolProvider,
} from "shared";
import { z } from "zod";
import { GenieConnector } from "../../connectors";
import { getWorkspaceClient } from "../../context";
import { buildToolkitEntries } from "../../core/agent/build-toolkit";
import {
  defineTool,
  executeFromRegistry,
  type ToolRegistry,
  toolsFromRegistry,
} from "../../core/agent/tools/define-tool";
import { createLogger } from "../../logging";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { genieStreamDefaults } from "./defaults";
import manifest from "./manifest.json";
import type {
  GenieConversationHistoryResponse,
  GenieSendMessageRequest,
  GenieStreamEvent,
  IGenieConfig,
} from "./types";

const logger = createLogger("genie");

export class GeniePlugin extends Plugin implements ToolProvider {
  static manifest = manifest as PluginManifest<"genie">;

  protected static description =
    "AI/BI Genie space integration for natural language data queries";
  protected declare config: IGenieConfig;

  private readonly genieConnector: GenieConnector;
  private tools: ToolRegistry = {};

  constructor(config: IGenieConfig) {
    super(config);
    this.config = {
      ...config,
      spaces: config.spaces ?? this.defaultSpaces(),
    };
    this.genieConnector = new GenieConnector({
      timeout: this.config.timeout,
      maxMessages: 200,
    });

    const spaces = this.config.spaces ?? {};
    const missingAliases = Object.entries(spaces)
      .filter(([, id]) => !id)
      .map(([alias]) => alias);
    if (missingAliases.length > 0) {
      const plural = missingAliases.length > 1;
      throw new Error(
        `GeniePlugin: space ${plural ? "aliases" : "alias"} ${missingAliases
          .map((a) => `"${a}"`)
          .join(
            ", ",
          )} ${plural ? "were" : "was"} configured with a missing Genie Space ID. ` +
          "This usually means an environment variable used to populate the config is unset. " +
          "Set the env var, or remove the alias from the config.",
      );
    }

    for (const alias of Object.keys(spaces)) {
      Object.assign(this.tools, this._defineSpaceTools(alias));
    }
  }

  /**
   * Builds the registry entries for a single Genie space alias.
   * One set of tools per configured space, keyed by `${alias}.${method}`.
   */
  private _defineSpaceTools(alias: string): ToolRegistry {
    return {
      [`${alias}.sendMessage`]: defineTool({
        description: `Send a natural language question to the Genie space "${alias}" and get data analysis results`,
        schema: z.object({
          content: z.string().describe("The natural language question to ask"),
          conversationId: z
            .string()
            .optional()
            .describe(
              "Optional conversation ID to continue an existing conversation",
            ),
        }),
        annotations: { requiresUserContext: true },
        handler: async (args) => {
          const events: GenieStreamEvent[] = [];
          for await (const event of this.sendMessage(
            alias,
            args.content,
            args.conversationId,
          )) {
            events.push(event);
          }
          return events;
        },
      }),
      [`${alias}.getConversation`]: defineTool({
        description: `Retrieve the conversation history from the Genie space "${alias}"`,
        schema: z.object({
          conversationId: z
            .string()
            .describe("The conversation ID to retrieve"),
        }),
        annotations: { readOnly: true, requiresUserContext: true },
        autoInheritable: true,
        handler: (args) => this.getConversation(alias, args.conversationId),
      }),
    };
  }

  private defaultSpaces(): Record<string, string | undefined> {
    const spaceId = process.env.DATABRICKS_GENIE_SPACE_ID;
    return spaceId ? { default: spaceId } : {};
  }

  private resolveSpaceId(alias: string): string | null {
    return this.config.spaces?.[alias] ?? null;
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "sendMessage",
      method: "post",
      path: "/:alias/messages",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleSendMessage(req, res);
      },
    });

    this.route(router, {
      name: "getConversation",
      method: "get",
      path: "/:alias/conversations/:conversationId",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleGetConversation(req, res);
      },
    });

    this.route(router, {
      name: "getMessage",
      method: "get",
      path: "/:alias/conversations/:conversationId/messages/:messageId",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleGetMessage(req, res);
      },
    });
  }

  async _handleSendMessage(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias } = req.params;
    const spaceId = this.resolveSpaceId(alias);

    if (!spaceId) {
      res.status(404).json({ error: `Unknown space alias: ${alias}` });
      return;
    }

    const { content, conversationId } = req.body as GenieSendMessageRequest;

    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    logger.debug(
      "Sending message to space %s (alias=%s, conversationId=%s)",
      spaceId,
      alias,
      conversationId ?? "new",
    );

    const timeout = this.config.timeout ?? 120_000;
    const requestId =
      (typeof req.query.requestId === "string" && req.query.requestId) ||
      randomUUID();

    const streamSettings: StreamExecutionSettings = {
      ...genieStreamDefaults,
      default: {
        ...genieStreamDefaults.default,
        timeout,
      },
      stream: {
        ...genieStreamDefaults.stream,
        streamId: requestId,
      },
    };

    const workspaceClient = getWorkspaceClient();

    await this.executeStream<GenieStreamEvent>(
      res,
      (signal) =>
        this.genieConnector.streamSendMessage(
          workspaceClient,
          spaceId,
          content,
          conversationId,
          { timeout, signal },
        ),
      streamSettings,
    );
  }

  async _handleGetConversation(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias, conversationId } = req.params;
    const spaceId = this.resolveSpaceId(alias);

    if (!spaceId) {
      res.status(404).json({ error: `Unknown space alias: ${alias}` });
      return;
    }

    const includeQueryResults = req.query.includeQueryResults !== "false";
    const pageToken =
      typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
    const requestId =
      (typeof req.query.requestId === "string" && req.query.requestId) ||
      randomUUID();

    logger.debug(
      "Fetching conversation %s from space %s (alias=%s, includeQueryResults=%s, pageToken=%s)",
      conversationId,
      spaceId,
      alias,
      includeQueryResults,
      pageToken ?? "none",
    );

    const streamSettings: StreamExecutionSettings = {
      ...genieStreamDefaults,
      stream: {
        ...genieStreamDefaults.stream,
        streamId: requestId,
      },
    };

    const workspaceClient = getWorkspaceClient();

    await this.executeStream<GenieStreamEvent>(
      res,
      (signal) =>
        this.genieConnector.streamConversation(
          workspaceClient,
          spaceId,
          conversationId,
          { includeQueryResults, pageToken, signal },
        ),
      streamSettings,
    );
  }

  async _handleGetMessage(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias, conversationId, messageId } = req.params;
    const spaceId = this.resolveSpaceId(alias);

    if (!spaceId) {
      res.status(404).json({ error: `Unknown space alias: ${alias}` });
      return;
    }

    const requestId =
      (typeof req.query.requestId === "string" && req.query.requestId) ||
      randomUUID();

    logger.debug(
      "Polling message %s in conversation %s from space %s (alias=%s)",
      messageId,
      conversationId,
      spaceId,
      alias,
    );

    const timeout = this.config.timeout ?? 120_000;
    const streamSettings: StreamExecutionSettings = {
      ...genieStreamDefaults,
      default: {
        ...genieStreamDefaults.default,
        timeout,
      },
      stream: {
        ...genieStreamDefaults.stream,
        streamId: requestId,
      },
    };

    const workspaceClient = getWorkspaceClient();

    await this.executeStream<GenieStreamEvent>(
      res,
      (signal) =>
        this.genieConnector.streamGetMessage(
          workspaceClient,
          spaceId,
          conversationId,
          messageId,
          { timeout, signal },
        ),
      streamSettings,
    );
  }

  async getConversation(
    alias: string,
    conversationId: string,
  ): Promise<GenieConversationHistoryResponse> {
    const spaceId = this.resolveSpaceId(alias);

    if (!spaceId) {
      throw new Error(`Unknown space alias: ${alias}`);
    }

    const workspaceClient = getWorkspaceClient();

    return this.genieConnector.getConversation(
      workspaceClient,
      spaceId,
      conversationId,
    );
  }

  /**
   * Send a message and consume events as a stream (message_start, status,
   * message_result, query_result, error).
   */
  async *sendMessage(
    alias: string,
    content: string,
    conversationId?: string,
    options?: { timeout?: number },
  ): AsyncGenerator<GenieStreamEvent> {
    const spaceId = this.resolveSpaceId(alias);
    if (!spaceId) {
      throw new Error(`Unknown space alias: ${alias}`);
    }
    const workspaceClient = getWorkspaceClient();
    const timeout = options?.timeout ?? this.config.timeout ?? 120_000;
    yield* this.genieConnector.streamSendMessage(
      workspaceClient,
      spaceId,
      content,
      conversationId,
      { timeout },
    );
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  toolkit(opts?: import("../../core/agent/types").ToolkitOptions) {
    return buildToolkitEntries(this.name, this.tools, opts);
  }

  exports() {
    return {
      sendMessage: this.sendMessage,
      getConversation: this.getConversation,
    };
  }
}

/**
 * @internal
 */
export const genie = toPlugin(GeniePlugin);

import { randomUUID } from "node:crypto";
import type express from "express";
import type { IAppRouter, StreamExecutionSettings } from "shared";
import { GenieConnector } from "../../connectors";
import { getWorkspaceClient } from "../../context";
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

export class GeniePlugin extends Plugin {
  name = "genie";

  static manifest = manifest as PluginManifest;

  protected static description =
    "AI/BI Genie space integration for natural language data queries";
  protected declare config: IGenieConfig;

  private readonly genieConnector: GenieConnector;

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
  }

  private defaultSpaces(): Record<string, string> {
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
    const requestId = (req.query.requestId as string) || randomUUID();

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
      () =>
        this.genieConnector.streamSendMessage(
          workspaceClient,
          spaceId,
          content,
          conversationId,
          { timeout },
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
    const requestId = (req.query.requestId as string) || randomUUID();

    logger.debug(
      "Fetching conversation %s from space %s (alias=%s, includeQueryResults=%s)",
      conversationId,
      spaceId,
      alias,
      includeQueryResults,
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
      () =>
        this.genieConnector.streamConversation(
          workspaceClient,
          spaceId,
          conversationId,
          { includeQueryResults },
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
export const genie = toPlugin<typeof GeniePlugin, IGenieConfig, "genie">(
  GeniePlugin,
  "genie",
);

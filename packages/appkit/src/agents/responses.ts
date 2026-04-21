import type {
  AgentAdapter,
  AgentAdapterConfig,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
} from "shared";
import { createLogger } from "../logging/logger";
import { buildOpenAIMessages, parseSseStream } from "./streaming";

const logger = createLogger("agent:supervisor-api");

// ---------------------------------------------------------------------------
// Supervisor API tool types (passed inline to the Responses API)
// ---------------------------------------------------------------------------

export interface GenieSpaceTool {
  type: "genie_space";
  genie_space: { id: string; description: string };
}

export interface UcFunctionTool {
  type: "uc_function";
  uc_function: { name: string; description: string };
}

export interface KnowledgeAssistantTool {
  type: "knowledge_assistant";
  knowledge_assistant: {
    knowledge_assistant_id: string;
    description: string;
  };
}

export interface AppTool {
  type: "app";
  app: { name: string; description: string };
}

export interface UcConnectionTool {
  type: "uc_connection";
  uc_connection: { name: string; description: string };
}

export type SupervisorApiHostedTool =
  | GenieSpaceTool
  | UcFunctionTool
  | KnowledgeAssistantTool
  | AppTool
  | UcConnectionTool;

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  host?: string;
  authenticate(headers: Headers): Promise<void>;
  ensureResolved(): Promise<void>;
}

export interface SupervisorApiOptions {
  workspaceClient: { config: WorkspaceConfig };
  /** Model name to use (e.g. "databricks-claude-sonnet-4-5"). */
  model: string;
  /** Optional system instructions prepended to every request. */
  instructions?: string;
  /** Tools in Supervisor API format, passed inline with every request. */
  tools?: SupervisorApiHostedTool[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter that calls the Databricks AI Gateway Responses API with
 * Supervisor API tool types.
 *
 * Stateless — each `run()` call POSTs to the endpoint with the full
 * conversation history and tools inline. No server-side agent entity
 * is created or managed.
 */
export class SupervisorApiAdapter implements AgentAdapter {
  private host: string;
  private authenticate: () => Promise<Record<string, string>>;
  private model: string;
  private instructions?: string;
  private inlineTools: SupervisorApiHostedTool[];

  private constructor(
    host: string,
    authenticate: () => Promise<Record<string, string>>,
    options: SupervisorApiOptions,
  ) {
    this.host = host;
    this.authenticate = authenticate;
    this.model = options.model;
    this.instructions = options.instructions;
    this.inlineTools = options.tools ?? [];
  }

  static async create(
    options: SupervisorApiOptions,
  ): Promise<SupervisorApiAdapter> {
    const config = options.workspaceClient.config;
    await config.ensureResolved();

    const rawHost = config.host ?? "";
    const host = rawHost.startsWith("http") ? rawHost : `https://${rawHost}`;
    const authenticate = async (): Promise<Record<string, string>> => {
      const headers = new Headers();
      await config.authenticate(headers);
      return Object.fromEntries(headers.entries());
    };

    return new SupervisorApiAdapter(host, authenticate, options);
  }

  async configure(config: AgentAdapterConfig): Promise<void> {
    if (config.toolDefinitions?.length) {
      logger.warn(
        "Supervisor API cannot use %d plugin tool(s) that require local execution: %s. " +
          "These tools will only work with adapters that support local tool calls (e.g. DatabricksAdapter).",
        config.toolDefinitions.length,
        config.toolDefinitions
          .map((t: AgentToolDefinition) => t.name)
          .join(", "),
      );
    }

    logger.info(
      "Configured with model '%s' and %d inline tool(s)",
      this.model,
      this.inlineTools.length,
    );
  }

  async *run(
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const messages = buildOpenAIMessages(input.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      input: messages,
      stream: true,
    };

    if (this.instructions) {
      body.instructions = this.instructions;
    }

    if (this.inlineTools.length > 0) {
      body.tools = this.inlineTools;
    }

    const authHeaders = await this.authenticate();
    const response = await fetch(
      `${this.host}/ai-gateway/mlflow/v1/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
        signal: context.signal,
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Supervisor API error (${response.status}): ${errorText}`,
      );
    }

    yield { type: "status", status: "running" };

    let receivedDeltas = false;
    for await (const parsed of parseSseStream(response, context.signal)) {
      const eventType: string = parsed.type ?? "";

      if (eventType === "response.output_text.delta" && parsed.delta) {
        receivedDeltas = true;
        yield { type: "message_delta" as const, content: parsed.delta };
      } else if (
        eventType === "response.function_call_arguments.delta" &&
        parsed.delta
      ) {
        yield {
          type: "tool_call" as const,
          callId: parsed.item_id ?? parsed.call_id ?? `resp_call_${Date.now()}`,
          name: parsed.name ?? "",
          args: parsed.delta,
        };
      } else if (eventType === "response.output_item.done") {
        const item = parsed.item;
        if (item?.type === "function_call") {
          yield {
            type: "tool_call" as const,
            callId: item.call_id ?? item.id ?? `resp_call_${Date.now()}`,
            name: item.name ?? "",
            args: item.arguments ?? "{}",
          };
        } else if (
          !receivedDeltas &&
          item?.type === "message" &&
          item.content
        ) {
          for (const part of item.content) {
            if (part.type === "output_text" && part.text) {
              yield { type: "message_delta" as const, content: part.text };
            }
          }
        }
      }
    }
  }
}

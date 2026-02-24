import type { BasePluginConfig } from "shared";
import type { GenieAttachmentResponse } from "../genie/types";

export interface IMultiGenieConfig extends BasePluginConfig {
  genieSpaces: Record<string, string>;
  /** Human-readable description per alias, injected into the agent system prompt */
  genieSpaceDescriptions?: Record<string, string>;
  /** OpenAI-compatible chat completions URL */
  endpoint: string;
  model?: string;
  /** Defaults to DATABRICKS_TOKEN env */
  endpointToken?: string;
  timeout?: number;
  maxIterations?: number;
  /** Replaces the default system prompt entirely */
  systemPrompt?: string;
}

export interface MultiGenieSendMessageRequest {
  content: string;
}

export type MultiGenieStreamEvent =
  | { type: "agent_start"; userMessage: string }
  | { type: "agent_thinking"; iteration: number }
  | { type: "routing"; genieSpaces: string[] }
  | {
      type: "genie_space_result";
      alias: string;
      spaceId: string;
      conversationId: string;
      messageId: string;
      content: string;
      attachments: GenieAttachmentResponse[];
      status: string;
    }
  | {
      type: "genie_query_result";
      alias: string;
      attachmentId: string;
      statementId: string;
      data: unknown;
    }
  | { type: "genie_space_error"; alias: string; error: string }
  | { type: "answer"; content: string }
  | { type: "error"; error: string };

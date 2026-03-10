import type { BasePluginConfig } from "shared";

// Re-export connector types for backward compatibility
export type { GenieStreamEvent } from "shared";
export type { GenieConversationHistoryResponse } from "../../connectors/genie";

export interface IGenieConfig extends BasePluginConfig {
  /** Map of alias → Genie Space ID. Defaults to { default: DATABRICKS_GENIE_SPACE_ID } if omitted. */
  spaces?: Record<string, string>;
  /** Genie polling timeout in ms. Set to 0 for indefinite. Default: 120000 (2 min) */
  timeout?: number;
}

export interface GenieSendMessageRequest {
  content: string;
  conversationId?: string;
}

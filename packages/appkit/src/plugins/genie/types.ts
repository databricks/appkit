import type { BasePluginConfig } from "shared";

// Re-export connector types for backward compatibility
export type { GenieStreamEvent } from "shared";
export type { GenieConversationHistoryResponse } from "../../connectors/genie";

export interface IGenieConfig extends BasePluginConfig {
  /**
   * Map of alias → Genie Space ID. Defaults to { default: DATABRICKS_GENIE_SPACE_ID } if omitted.
   *
   * Values may be `undefined` so callers can pass `process.env.X` directly
   * (which is `string | undefined`) without a hoist-and-narrow dance. Aliases
   * with undefined values resolve to "unknown alias" at request time, same
   * as missing keys.
   */
  spaces?: Record<string, string | undefined>;
  /** Genie polling timeout in ms. Set to 0 for indefinite. Default: 120000 (2 min) */
  timeout?: number;
}

export interface GenieSendMessageRequest {
  content: string;
  conversationId?: string;
}

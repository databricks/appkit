import type { AiFunctionTasks, BasePluginConfig, RetryConfig } from "shared";

// Re-export the shared AI Functions types so existing `./types` imports keep
// working. List names explicitly: re-exporting all of "shared" would leak
// unrelated types through the plugin barrel.
export type {
  AiFunctionName,
  AiFunctionTask,
  AiFunctionTaskInput,
  AiFunctionTaskResult,
  AiFunctionTasks,
  ClassifyRequest,
  ClassifyResponse,
  DecideRequest,
  DecideResponse,
  ExtractField,
  ExtractRequest,
  ExtractResponse,
  StructuredInput,
  StructuredObject,
} from "shared";

export interface IAiFunctionsConfig extends BasePluginConfig {
  /** Timeout in milliseconds for one upstream attempt. @default 60000 */
  timeout?: number;
  /**
   * Retry for unavailable (503) responses, and for any rate-limit (429)
   * response that reaches the plugin. In practice the Databricks SDK retries
   * 429 internally until `timeout` cancels it, so a sustained rate limit
   * surfaces as a 504. Other errors are never retried.
   * @default { enabled: true, attempts: 3, initialDelay: 1000, maxDelay: 10000 }
   */
  retry?: RetryConfig;
  /** Named tasks exposed through HTTP routes, `useAiFunction`, and agent tools. */
  tasks?: AiFunctionTasks;
}

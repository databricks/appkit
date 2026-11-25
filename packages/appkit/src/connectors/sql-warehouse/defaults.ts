import type { ExecuteStatementRequest } from "../../workspace-client";

interface ExecuteStatementDefaults {
  waitTimeout: string;
  disposition: ExecuteStatementRequest["disposition"];
  format: ExecuteStatementRequest["format"];
  onWaitTimeout: ExecuteStatementRequest["onWaitTimeout"];
  timeout: number;
}

// @TODO: Make these configurable globally and validate right values
export const executeStatementDefaults: ExecuteStatementDefaults = {
  waitTimeout: "30s",
  disposition: "INLINE",
  format: "JSON_ARRAY",
  onWaitTimeout: "CONTINUE",
  timeout: 60000,
};

/**
 * Maximum size for inline Arrow IPC attachments (25 MiB decoded — the
 * Databricks Statement Execution API hard cap on INLINE responses).
 *
 * The analytics route streams the decoded attachment straight back on the
 * query response body; this cap bounds the single in-memory copy. Larger
 * results fall through to `disposition: "EXTERNAL_LINKS"`, which streams
 * chunk-by-chunk and is not bound by this limit.
 */
export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

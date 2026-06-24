import type { Context } from "@opentelemetry/api";
import type { IAppResponse } from "shared";
import type { EventRingBuffer } from "./buffers";

export const SSEWarningCode = {
  BUFFER_OVERFLOW_RESTART: "BUFFER_OVERFLOW_RESTART",
} as const satisfies Record<string, string>;

export type SSEWarningCode =
  (typeof SSEWarningCode)[keyof typeof SSEWarningCode];

export const SSEErrorCode = {
  TEMPORARY_UNAVAILABLE: "TEMPORARY_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  STREAM_ABORTED: "STREAM_ABORTED",
  STREAM_EVICTED: "STREAM_EVICTED",
  STREAM_FORBIDDEN: "STREAM_FORBIDDEN",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
} as const satisfies Record<string, string>;

export type SSEErrorCode = (typeof SSEErrorCode)[keyof typeof SSEErrorCode];

export interface SSEError {
  error: string;
  code: SSEErrorCode;
  /**
   * Upstream-domain structured code (e.g. `RESULT_TOO_LARGE_FOR_JSON_FALLBACK`,
   * `NOT_IMPLEMENTED`). UI code should branch on this instead of parsing
   * the human-readable `error` string.
   */
  errorCode?: string;
}

export interface BufferedEvent {
  id: string;
  type: string;
  data: string;
  timestamp: number;
}

export interface StreamEntry {
  streamId: string;
  /**
   * Identifier of the principal that created the stream (e.g. end-user ID
   * or service principal user ID). When set, only requests sharing the
   * same owner key may reconnect to the stream.
   */
  ownerKey?: string;
  generator: AsyncGenerator<any, void, unknown>;
  eventBuffer: EventRingBuffer;
  clients: Set<IAppResponse>;
  isCompleted: boolean;
  lastAccess: number;
  abortController: AbortController;
  traceContext: Context;
  // pending grace-window abort, set while the last client is disconnected
  disconnectGraceTimer?: NodeJS.Timeout;
  /**
   * Pending registry-removal timer. At most one removal timer exists per
   * stream; scheduling a new one clears any previous timer first.
   */
  removalTimer?: NodeJS.Timeout;
}

export interface StreamOperation {
  controller: AbortController;
  type: "query" | "stream";
  heartbeat?: NodeJS.Timeout;
}

// clear a pending disconnect-grace timer so a removed/reconnected stream
// isn't pinned until it fires
export function clearGraceTimer(entry: StreamEntry): void {
  if (entry.disconnectGraceTimer) {
    clearTimeout(entry.disconnectGraceTimer);
    entry.disconnectGraceTimer = undefined;
  }
}

// clear a pending registry-removal timer so a reconnected/evicted stream
// isn't pulled out from under a client
export function clearRemovalTimer(entry: StreamEntry): void {
  if (entry.removalTimer) {
    clearTimeout(entry.removalTimer);
    entry.removalTimer = undefined;
  }
}

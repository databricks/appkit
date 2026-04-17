import type { SseEnvelope } from "@databricks/appkit-contracts";
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
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
} as const satisfies Record<string, string>;

export type SSEErrorCode = (typeof SSEErrorCode)[keyof typeof SSEErrorCode];

export interface SSEError {
  error: string;
  code: SSEErrorCode;
}

export interface BufferedEvent {
  id: string;
  type: string;
  data: string;
  timestamp: number;
}

// Compile-time anchor against contracts/appkit/v1/wire.proto. When BufferedEvent
// and the generated SseEnvelope diverge, tsc fails here — a signal that either
// the contract or the implementation needs updating. Follow-up PRs will retire
// BufferedEvent in favour of the generated type.
type _BufferedEventSseEnvelopeCompat = {
  id: BufferedEvent["id"] extends SseEnvelope["id"] ? true : never;
  data: BufferedEvent["data"] extends SseEnvelope["data"] ? true : never;
};

export interface StreamEntry {
  streamId: string;
  generator: AsyncGenerator<any, void, unknown>;
  eventBuffer: EventRingBuffer;
  clients: Set<IAppResponse>;
  isCompleted: boolean;
  lastAccess: number;
  abortController: AbortController;
  traceContext: Context;
}

export interface StreamOperation {
  controller: AbortController;
  type: "query" | "stream";
  heartbeat?: NodeJS.Timeout;
}

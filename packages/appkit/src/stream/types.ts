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

export interface StreamEntry {
  streamId: string;
  generator: AsyncGenerator<any, void, unknown>;
  eventBuffer: EventRingBuffer;
  clients: Set<IAppResponse>;
  isCompleted: boolean;
  lastAccess: number;
  abortController: AbortController;
}

export interface BufferEntry {
  buffer: EventRingBuffer;
  lastAccess: number;
}

export interface StreamOperation {
  controller: AbortController;
  type: "query" | "stream";
  heartbeat?: NodeJS.Timeout;
}

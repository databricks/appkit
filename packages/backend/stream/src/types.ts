import type { EventRingBuffer } from "./buffer-manager";

export const SSEWarningCode = {
  BUFFER_OVERFLOW_RESTART: "BUFFER_OVERFLOW_RESTART",
} as const satisfies Record<string, string>;

export type SSEWarningCode =
  (typeof SSEWarningCode)[keyof typeof SSEWarningCode];

export interface BufferedEvent {
  id: string;
  type: string;
  data: string;
  timestamp: number;
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

export interface StreamOptions {
  userSignal?: AbortSignal;
  streamId?: string;
  bufferSize?: number;
  maxEventSize?: number;
  bufferTTL?: number;
  cleanupInterval?: number;
  maxPersistentBuffers?: number;
  heartbeatInterval?: number;
}

/**
 * Delivery Layer Types - Stream Types for event delivery
 */

import type { TaskEvent } from "@/domain";
import type { RingBuffer } from "./ring-buffer";

/**
 * Task event with sequence number for ordering and reconnection
 */
export type StreamTaskEvent = TaskEvent & { seq: number };

/**
 * Options for creating a stream generator
 */
export interface TaskStreamOptions {
  /** Last sequence number received (for reconnection) */
  lastSeq?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Internal stream state
 */
export interface TaskStream {
  /** Ring buffer holding sequenced events */
  buffer: RingBuffer<StreamTaskEvent>;
  /** Set of listener callbacks to notify on new events */
  listeners: Set<() => void>;
  /** Whether the stream has been closed */
  closed: boolean;
  /** Cleanup timer handle (for delayed deletion after close) */
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  /** Next sequence number to assign */
  nextSeq: number;
}

/**
 * Stream configuration
 */
export interface StreamConfig {
  /** How long to retain closed streams before cleanup (ms) */
  streamRetentionMs: number;
  /** Maximum events to buffer per stream */
  streamBufferSize: number;
}

/**
 * Default stream configuration
 */
export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  streamRetentionMs: 60_000, // 1 minute
  streamBufferSize: 100,
};

/**
 * Comprehensive stream statistics for monitoring
 */
export interface StreamStats {
  /** Stream counts */
  streams: {
    active: number;
    closed: number;
    total: number;
  };

  /** Configuration */
  config: {
    retentionMs: number;
    bufferSize: number;
  };

  /** Listener statistics */
  listeners: {
    total: number;
    streamsWithListeners: number;
    maxOnSingleStream: number;
  };

  /** Buffer statistics */
  buffer: {
    totalEvents: number;
    overflows: number;
  };

  /** Event flow statistics */
  events: {
    pushed: number;
    consumed: number;
  };

  /** Debug information */
  debug: {
    topStreamsByBufferedEvents: Array<{
      idempotencyKey: string;
      bufferedEvents: number;
      listeners: number;
      closed: boolean;
    }>;
  };
}

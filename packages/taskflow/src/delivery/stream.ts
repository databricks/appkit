/**
 * Stream Manager - Manages event streams for SSE delivery
 *
 * Provides event streaming with:
 * - Ring buffer for event replay on reconnection
 * - Sequence numbers for ordering
 * - AbortSignal support for cancellation
 * - Automatic cleanup of closed streams
 */

import type { IdempotencyKey } from "@/core/branded";
import { StreamOverflowError, ValidationError } from "@/core/errors";
import type { TaskEvent } from "@/domain";
import { noopHooks, TaskMetrics, type TaskSystemHooks } from "@/observability";
import { RingBuffer } from "./ring-buffer";
import {
  DEFAULT_STREAM_CONFIG,
  type StreamConfig,
  type StreamStats,
  type StreamTaskEvent,
  type TaskStream,
  type TaskStreamOptions,
} from "./types";

/**
 * Manages event streams for SSE delivery with reconnection support
 */
export class StreamManager {
  private readonly config: StreamConfig;
  private readonly hooks: TaskSystemHooks;

  private readonly streams: Map<string, TaskStream>;
  private overflowCount: number;
  private eventsPushed: number;
  private eventsConsumed: number;

  constructor(
    config?: Partial<StreamConfig>,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.config = {
      ...DEFAULT_STREAM_CONFIG,
      ...config,
    };
    this.hooks = hooks;

    this.streams = new Map();
    this.overflowCount = 0;
    this.eventsPushed = 0;
    this.eventsConsumed = 0;
  }

  /**
   * Get or create a stream for the given idempotency key
   */
  getOrCreate(idempotencyKey: string): TaskStream {
    this.validateIdempotencyKey(idempotencyKey);

    const existing = this.streams.get(idempotencyKey);
    if (existing) return existing;

    const stream: TaskStream = {
      buffer: new RingBuffer<StreamTaskEvent>(
        this.config.streamBufferSize,
        (event) => String(event.seq),
      ),
      listeners: new Set(),
      closed: false,
      cleanupTimer: null,
      nextSeq: 1,
    };

    // add stream to map
    this.streams.set(idempotencyKey, stream);

    // record gauge for active streams
    this.hooks.recordGauge(TaskMetrics.STREAMS_ACTIVE, this.streams.size);

    return stream;
  }

  /**
   * Get an existing stream (does not create)
   */
  get(idempotencyKey: string): TaskStream | undefined {
    this.validateIdempotencyKey(idempotencyKey);
    return this.streams.get(idempotencyKey);
  }

  /**
   * Push an event to a stream
   */
  push(idempotencyKey: string, event: TaskEvent): void {
    this.validateIdempotencyKey(idempotencyKey);
    const stream = this.streams.get(idempotencyKey);
    if (!stream) return;

    const sequencedEvent: StreamTaskEvent = {
      ...event,
      seq: stream.nextSeq++,
    };

    stream.buffer.add(sequencedEvent);
    this.eventsPushed++;

    // notify all listeners
    for (const listener of stream.listeners) {
      listener();
    }

    // record metrics
    this.hooks.incrementCounter(TaskMetrics.FLUSH_ENTRIES, 1, {
      stream: idempotencyKey,
    });
  }

  /**
   * Close a stream
   */

  close(idempotencyKey: string): void {
    this.validateIdempotencyKey(idempotencyKey);

    const stream = this.streams.get(idempotencyKey);
    if (!stream || stream.closed) return;
    stream.closed = true;

    // notify all listeners stream is closing
    for (const listener of stream.listeners) {
      listener();
    }
    stream.listeners.clear();

    // clear any existing cleanup timer
    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer);
    }

    // schedule cleanup after retention period
    stream.cleanupTimer = setTimeout(() => {
      const current = this.streams.get(idempotencyKey);
      if (current === stream) {
        this.streams.delete(idempotencyKey);
        this.hooks.recordGauge(
          TaskMetrics.STREAMS_ACTIVE,
          this.getActiveCount(),
        );
      }
    }, this.config.streamRetentionMs);

    // use unref() to not block process exit
    if (stream.cleanupTimer.unref) {
      stream.cleanupTimer.unref();
    }
  }

  /**
   * Create an async generator for streaming events
   */
  async *createGenerator(
    idempotencyKey: IdempotencyKey,
    options?: TaskStreamOptions,
  ): AsyncGenerator<TaskEvent, void, unknown> {
    this.validateIdempotencyKey(idempotencyKey);

    const stream = this.streams.get(idempotencyKey);
    if (!stream) return;

    let lastSeq: number = options?.lastSeq ?? 0;
    const signal = options?.signal;

    while (true) {
      // check for abort
      if (signal?.aborted) return;

      const allEvents = stream.buffer.getAll();

      // check for overflow (reconnection with evicted events)
      if (allEvents.length > 0) {
        const minSeq = allEvents[0].seq;

        if (lastSeq !== 0 && lastSeq < minSeq) {
          this.overflowCount++;
          throw new StreamOverflowError(
            `Stream overflow: requested seq ${lastSeq} has been evicted (min: ${minSeq})`,
            {
              idempotencyKey,
              lastSeq: String(lastSeq),
              minSeq: String(minSeq),
            },
          );
        }
      }

      // yield events newer than lastSeq
      for (const event of allEvents) {
        if (event.seq > lastSeq) {
          yield event;
          lastSeq = event.seq;
          this.eventsConsumed++;
        }
      }

      // if stream is closed, finish
      if (stream.closed) return;

      // wait for new events or close
      await new Promise<void>((resolve, reject) => {
        const listener = () => {
          stream.listeners.delete(listener);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };

        const onAbort = () => {
          stream.listeners.delete(listener);
          signal?.removeEventListener("abort", onAbort);
          reject(signal?.reason ?? new Error("Stream aborted"));
        };

        stream.listeners.add(listener);

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }

          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  /**
   * Clear all streams and cancel cleanup timers
   */
  clearAll(): void {
    for (const stream of this.streams.values()) {
      if (stream.cleanupTimer) {
        clearTimeout(stream.cleanupTimer);
      }
    }

    this.streams.clear();
    this.overflowCount = 0;
    this.eventsPushed = 0;
    this.eventsConsumed = 0;
    this.hooks.recordGauge(TaskMetrics.STREAMS_ACTIVE, 0);
  }

  /**
   * Get the listener count for a stream
   */
  getListenerCount(idempotencyKey: IdempotencyKey): number {
    this.validateIdempotencyKey(idempotencyKey);
    return this.streams.get(idempotencyKey)?.listeners.size ?? 0;
  }

  /**
   * Get comprehensive statistics
   */
  getStats(): StreamStats {
    let activeStream = 0;
    let closedStream = 0;
    let totalListeners = 0;
    let totalBufferedEvents = 0;
    let streamsWithListeners = 0;
    let maxListenersOnSingleStream = 0;

    const streamData: Array<{
      idempotencyKey: string;
      bufferedEvents: number;
      listeners: number;
      closed: boolean;
    }> = [];

    for (const [key, stream] of this.streams) {
      stream.closed ? closedStream++ : activeStream++;

      const listenerCount = stream.listeners.size;
      totalListeners += listenerCount;

      if (listenerCount > 0) streamsWithListeners++;

      if (listenerCount > maxListenersOnSingleStream)
        maxListenersOnSingleStream = listenerCount;

      const bufferedEvents = stream.buffer.getAll().length;
      totalBufferedEvents += bufferedEvents;

      streamData.push({
        idempotencyKey: key,
        bufferedEvents,
        listeners: listenerCount,
        closed: stream.closed,
      });
    }

    // sort by buffered events descending
    streamData.sort((a, b) => b.bufferedEvents - a.bufferedEvents);

    return {
      streams: {
        active: activeStream,
        closed: closedStream,
        total: this.streams.size,
      },
      config: {
        retentionMs: this.config.streamRetentionMs,
        bufferSize: this.config.streamBufferSize,
      },
      listeners: {
        total: totalListeners,
        streamsWithListeners,
        maxOnSingleStream: maxListenersOnSingleStream,
      },
      buffer: {
        totalEvents: totalBufferedEvents,
        overflows: this.overflowCount,
      },
      events: {
        pushed: this.eventsPushed,
        consumed: this.eventsConsumed,
      },
      debug: {
        topStreamsByBufferedEvents: streamData.slice(0, 10),
      },
    };
  }

  /**
   * Get count of active (non-closed) streams
   */
  private getActiveCount(): number {
    let count = 0;
    for (const stream of this.streams.values()) {
      if (!stream.closed) count++;
    }
    return count;
  }

  /**
   * Validate idempotency key
   */
  private validateIdempotencyKey(idempotencyKey: string): void {
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new ValidationError("Invalid idempotency key", "idempotencyKey");
    }
  }
}

import { clearGraceTimer, clearRemovalTimer } from "./timers";
import { SSEErrorCode, type StreamEntry } from "./types";

export class StreamRegistry {
  // keyed storage with explicit, policy-driven eviction. A ring buffer is
  // unsuitable here: it overwrites by insertion slot, so evicting an entry
  // chosen by policy (e.g. a completed stream) and then adding would
  // silently clobber an unrelated live stream sitting in the oldest slot.
  private streams: Map<string, StreamEntry>;
  private maxActiveStreams: number;

  constructor(maxActiveStreams: number) {
    this.streams = new Map();
    this.maxActiveStreams = maxActiveStreams;
  }

  // add a stream to the registry
  add(entry: StreamEntry): void {
    // enforce hard cap, but only when inserting a genuinely new key:
    // re-adding an existing streamId updates in place and doesn't grow the
    // map, so evicting another stream for it would destroy an innocent one
    if (
      !this.streams.has(entry.streamId) &&
      this.streams.size >= this.maxActiveStreams
    ) {
      this._evictOldestStream(entry.streamId);
    }

    this.streams.set(entry.streamId, entry);
  }

  // get a stream from the registry
  get(streamId: string): StreamEntry | null {
    return this.streams.get(streamId) ?? null;
  }

  // check if a stream exists in the registry
  has(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  // remove a stream from the registry
  remove(streamId: string): void {
    this.streams.delete(streamId);
  }

  // get the number of streams in the registry
  size(): number {
    return this.streams.size;
  }

  clear(): void {
    for (const stream of this.streams.values()) {
      stream.abortController.abort("Server shutdown");
      clearGraceTimer(stream);
      clearRemovalTimer(stream);
    }

    this.streams.clear();
  }

  // evict the oldest stream from the registry, preferring completed streams.
  // Completed streams waiting out their buffer TTL can look recently
  // accessed, so plain LRU could evict a live stream while dead ones
  // survive. Prefer the oldest completed stream when one exists and fall
  // back to LRU over all streams otherwise.
  private _evictOldestStream(excludeStreamId: string): void {
    const allStreams = this.streams.values();
    let oldestStream: StreamEntry | null = null;
    let oldestAccess = Infinity;
    let oldestCompletedStream: StreamEntry | null = null;
    let oldestCompletedAccess = Infinity;

    // find the least recently accessed stream (overall and completed-only)
    for (const stream of allStreams) {
      if (stream.streamId === excludeStreamId) continue;

      if (stream.lastAccess < oldestAccess) {
        oldestStream = stream;
        oldestAccess = stream.lastAccess;
      }

      if (stream.isCompleted && stream.lastAccess < oldestCompletedAccess) {
        oldestCompletedStream = stream;
        oldestCompletedAccess = stream.lastAccess;
      }
    }

    oldestStream = oldestCompletedStream ?? oldestStream;

    // abort the evicted stream
    if (oldestStream) {
      // broadcast stream eviction error to all clients
      for (const client of oldestStream.clients) {
        if (!client.writableEnded) {
          try {
            client.write(`event: error\n`);
            client.write(
              `data: ${JSON.stringify({ error: "Stream evicted", code: SSEErrorCode.STREAM_EVICTED })}\n\n`,
            );
          } catch (_error) {
            // ignore
          }
        }
      }
      clearGraceTimer(oldestStream);
      // abort with a DOMException AbortError so the error categorizer routes
      // eviction as an abort (matching the manager's terminal paths) rather
      // than a stream failure
      oldestStream.abortController.abort(
        new DOMException("Stream evicted", "AbortError"),
      );
      // a pending removal timer would otherwise pin the evicted entry
      clearRemovalTimer(oldestStream);
      this.streams.delete(oldestStream.streamId);
    }
  }
}

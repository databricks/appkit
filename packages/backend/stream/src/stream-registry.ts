import { RingBuffer } from "./buffers";
import { SSEErrorCode, type StreamEntry } from "./types";

export class StreamRegistry {
  private streams: RingBuffer<StreamEntry>;

  constructor(maxActiveStreams: number) {
    this.streams = new RingBuffer<StreamEntry>(
      maxActiveStreams,
      (entry) => entry.streamId,
    );
  }

  // add a stream to the registry
  add(entry: StreamEntry): void {
    // enforce hard cap
    if (this.streams.getSize() >= this.streams.capacity) {
      this._evictOldestStream(entry.streamId);
    }

    this.streams.add(entry);
  }

  // get a stream from the registry
  get(streamId: string): StreamEntry | null {
    return this.streams.get(streamId);
  }

  // check if a stream exists in the registry
  has(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  // remove a stream from the registry
  remove(streamId: string): void {
    this.streams.remove(streamId);
  }

  // get the number of streams in the registry
  size(): number {
    return this.streams.getSize();
  }

  clear(): void {
    const allStreams = this.streams.getAll();

    for (const stream of allStreams) {
      stream.abortController.abort("Server shutdown");
    }

    this.streams.clear();
  }

  // evict the oldest stream from the registry
  private _evictOldestStream(excludeStreamId: string): void {
    const allStreams = this.streams.getAll();
    let oldestStream: StreamEntry | null = null;
    let oldestAccess = Infinity;

    // find the least recently accessed stream
    for (const stream of allStreams) {
      if (
        stream.streamId !== excludeStreamId &&
        stream.lastAccess < oldestAccess
      ) {
        oldestStream = stream;
        oldestAccess = stream.lastAccess;
      }
    }

    // abort the oldest stream
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
      oldestStream.abortController.abort("Stream evicted");
      this.streams.remove(oldestStream.streamId);
    }
  }
}

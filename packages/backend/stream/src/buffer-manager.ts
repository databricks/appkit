import { streamDefaults } from "./defaults";
import type { BufferedEvent, BufferEntry, StreamOptions } from "./types";
import { StreamValidator } from "./validator";

export class EventRingBuffer {
  private buffer: (BufferedEvent | null)[];
  private capacity: number;
  private writeIndex: number;
  private size: number;

  constructor(capacity: number = 100) {
    if (capacity <= 0) {
      throw new Error("Capacity must be greater than 0");
    }

    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(null);
    this.writeIndex = 0;
    this.size = 0;
  }

  // add an event to the buffer
  add(event: BufferedEvent): void {
    this.buffer[this.writeIndex] = event;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  // get events since last event id
  getEventsSince(lastEventId: string): BufferedEvent[] {
    const result: BufferedEvent[] = [];
    let foundLastEvent = false;

    for (let i = 0; i < this.size; i++) {
      const nextEventIndex =
        (this.writeIndex - this.size + i + this.capacity) % this.capacity;
      const event = this.buffer[nextEventIndex];

      if (!event) continue;

      if (foundLastEvent) {
        result.push(event);
      } else if (event.id === lastEventId) {
        foundLastEvent = true;
      }
    }
    return result;
  }

  // check if a buffer has an event
  has(eventId: string): boolean {
    for (let i = 0; i < this.size; i++) {
      const index =
        (this.writeIndex - this.size + i + this.capacity) % this.capacity;
      const event = this.buffer[index];
      if (event?.id === eventId) {
        return true;
      }
    }
    return false;
  }
}

export class BufferManager {
  private persistentBuffers: Map<string, BufferEntry> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  private bufferTTL: number;
  private maxPersistentBuffers: number;
  private cleanupIntervalMS: number;

  constructor(options?: StreamOptions) {
    this.bufferTTL = options?.bufferTTL ?? streamDefaults.bufferTTL;
    this.maxPersistentBuffers =
      options?.maxPersistentBuffers ?? streamDefaults.maxPersistentBuffers;
    this.cleanupIntervalMS =
      options?.cleanupInterval ?? streamDefaults.cleanupInterval;

    this.cleanupInterval = setInterval(() => {
      this._cleanupStaleBuffers();
    }, this.cleanupIntervalMS);
  }

  // get or create a buffer from the manager
  getOrCreateBuffer(options?: StreamOptions): EventRingBuffer {
    const { streamId, bufferSize = streamDefaults.bufferSize } = options || {};

    if (!streamId) {
      return new EventRingBuffer(bufferSize);
    }

    StreamValidator.validateStreamId(streamId);

    const existingEntry = this.persistentBuffers.get(streamId);
    if (existingEntry) {
      existingEntry.lastAccess = Date.now();
      return existingEntry.buffer;
    }

    // evict lru if at capacity
    if (this.persistentBuffers.size >= this.maxPersistentBuffers) {
      this._evictLRU();
    }

    const newBuffer = new EventRingBuffer(bufferSize);
    this.persistentBuffers.set(streamId, {
      buffer: newBuffer,
      lastAccess: Date.now(),
    });
    return newBuffer;
  }

  // get a buffer from the manager
  getBuffer(streamId: string): BufferEntry | undefined {
    return this.persistentBuffers.get(streamId);
  }

  // delete a buffer from the manager
  deleteBuffer(streamId: string): void {
    this.persistentBuffers.delete(streamId);
  }

  // clear all buffers
  clear(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.persistentBuffers.clear();
  }

  // cleanup stale buffers based on TTL
  private _cleanupStaleBuffers(): void {
    const now = Date.now();
    const staleStreamids: string[] = [];

    for (const [streamId, entry] of this.persistentBuffers.entries()) {
      if (now - entry.lastAccess > this.bufferTTL) {
        staleStreamids.push(streamId);
      }
    }

    for (const streamId of staleStreamids) {
      this.persistentBuffers.delete(streamId);
    }
  }

  // evict the least recently used buffer
  private _evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [streamId, entry] of this.persistentBuffers.entries()) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = streamId;
      }
    }

    if (oldestKey) {
      this.persistentBuffers.delete(oldestKey);
    }
  }
}

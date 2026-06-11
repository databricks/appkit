import { ValidationError } from "../errors";
import type { BufferedEvent } from "./types";

// generic ring buffer implementation
export class RingBuffer<T> {
  // internal storage; external mutation would break the keyIndex/size invariants
  private buffer: (T | null)[];
  public readonly capacity: number;
  private writeIndex: number;
  private size: number;
  private keyExtractor: (item: T) => string;
  private keyIndex: Map<string, number>;

  constructor(capacity: number, keyExtractor: (item: T) => string) {
    if (capacity <= 0) {
      throw ValidationError.invalidValue(
        "capacity",
        capacity,
        "greater than 0",
      );
    }

    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(null);
    this.writeIndex = 0;
    this.size = 0;
    this.keyExtractor = keyExtractor;
    this.keyIndex = new Map();
  }

  // add an item to the buffer
  add(item: T): void {
    const key = this.keyExtractor(item);

    // check if item already exists
    const existingIndex = this.keyIndex.get(key);
    if (existingIndex !== undefined) {
      // update existing item
      this.buffer[existingIndex] = item;
      return;
    }

    // if there is free space but writeIndex points at a live entry
    // (holes created by remove()), insert into a freed slot instead of
    // silently overwriting a live, still-indexed entry.
    // The `buffer[writeIndex] !== null` guard is what keeps add-only (event)
    // buffers O(1) per add — this hole-scan only runs after a remove() — and
    // must not be simplified away.
    if (this.size < this.capacity && this.buffer[this.writeIndex] !== null) {
      for (let i = 1; i < this.capacity; i++) {
        const candidate = (this.writeIndex + i) % this.capacity;
        if (this.buffer[candidate] === null) {
          this.buffer[candidate] = item;
          this.keyIndex.set(key, candidate);
          this.size++;
          return;
        }
      }
    }

    // evict the oldest-inserted item if the buffer is truly full
    // (add-only ring semantics, e.g. event replay buffers).
    // Note: StreamRegistry pre-evicts via its own LRU policy before calling
    // add(), so callers managing keyed live entries should never reach this
    // FIFO overwrite branch — it exists as a fallback.
    const evicted = this.buffer[this.writeIndex];
    if (evicted !== null) {
      const evictedKey = this.keyExtractor(evicted);
      this.keyIndex.delete(evictedKey);
    }

    // add new item
    this.buffer[this.writeIndex] = item;
    this.keyIndex.set(key, this.writeIndex);

    // update write index and size
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  // get an item from the buffer
  get(key: string): T | null {
    const index = this.keyIndex.get(key);
    if (index === undefined) return null;

    return this.buffer[index];
  }

  // check if an item exists in the buffer
  has(key: string): boolean {
    return this.keyIndex.has(key);
  }

  // remove an item from the buffer
  remove(key: string): void {
    const index = this.keyIndex.get(key);
    if (index === undefined) return;

    // remove item from buffer
    this.buffer[index] = null;
    this.keyIndex.delete(key);

    // update size
    this.size = Math.max(this.size - 1, 0);
  }

  /**
   * Returns all surviving items in slot-scan order, starting at `writeIndex`
   * and skipping holes left by `remove()`.
   *
   * Ordering contract: insertion order is only guaranteed for add-only
   * buffers (no `remove()` calls). Once removals occur, the hole-filling
   * in `add()` may place newer items in freed slots anywhere in the ring,
   * so the resulting order is usage-dependent — only completeness (every
   * surviving entry is returned exactly once) is guaranteed.
   */
  getAll(): T[] {
    const result: T[] = [];

    // walk every slot starting at writeIndex, skipping holes left by
    // remove(). For add-only buffers writeIndex is the oldest slot when
    // full, so this yields items in insertion order; for buffers with
    // removals writeIndex is just a stable scan origin and the walk only
    // guarantees every surviving entry is returned.
    for (let i = 0; i < this.capacity; i++) {
      const index = (this.writeIndex + i) % this.capacity;
      const item = this.buffer[index];
      if (item !== null) {
        result.push(item);
      }
    }
    return result;
  }

  // get the size of the buffer
  getSize(): number {
    return this.size;
  }

  // clear the buffer
  clear(): void {
    this.buffer = new Array(this.capacity).fill(null);
    this.keyIndex.clear();
    this.writeIndex = 0;
    this.size = 0;
  }
}

// event ring buffer implementation.
// Intentionally add-only: replay ordering relies on getAll() returning items
// in insertion order, which only holds when remove() is never called.
export class EventRingBuffer {
  private buffer: RingBuffer<BufferedEvent>;

  constructor(capacity: number = 100) {
    this.buffer = new RingBuffer<BufferedEvent>(capacity, (event) => event.id);
  }

  // add an event to the buffer
  add(event: BufferedEvent): void {
    this.buffer.add(event);
  }

  // check if an event exists in the buffer
  has(eventId: string): boolean {
    return this.buffer.has(eventId);
  }

  // get all events since a given event id.
  // Contract note: an empty result is ambiguous — it can mean either "the
  // client is caught up" or "lastEventId was evicted by ring wrap". Callers
  // must pre-check has(lastEventId) (as stream-manager does) to distinguish
  // the two cases; the return type intentionally stays BufferedEvent[].
  getEventsSince(lastEventId: string): BufferedEvent[] {
    const allEvents = this.buffer.getAll();
    const result: BufferedEvent[] = [];
    // flag to track if we've found the last event
    let foundLastEvent = false;

    // iterate over all events
    for (const event of allEvents) {
      // if found, add to result
      if (foundLastEvent) {
        result.push(event);
        // if not found, check if it's the last event
      } else if (event.id === lastEventId) {
        foundLastEvent = true;
      }
    }
    return result;
  }

  clear(): void {
    this.buffer.clear();
  }
}

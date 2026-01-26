/**
 * Ring buffer - Fixed size circular buffer with FIFO eviction
 *
 * Used for buffering stream events with automatic eviction of oldest
 * items when capacity is reached. Supports key-based deduplication
 * and O(1) lookup
 */

import { ValidationError } from "@/core/errors";

/**
 * Generic ring buffer with key-based lookup and FIFO eviction
 */
export class RingBuffer<T> {
  /** Internal buffer array */
  private buffer: (T | null)[];
  /** Maximum capacity */
  private readonly capacity: number;
  /** Current write position */
  private writeIndex: number;
  /** Number of items in buffer */
  private size: number;
  /** Function to extract key from item */
  private readonly keyExtractor: (item: T) => string;
  /** Map from key to buffer index for O(1) lookup */
  private keyIndex: Map<string, number>;
  /** Count of evicted items (overflow) */
  private overflowCount: number;

  constructor(capacity: number, keyExtractor: (item: T) => string) {
    if (capacity <= 0) {
      throw new ValidationError(
        `Ring buffer capacity must be greater than 0, got ${capacity}`,
        "capacity",
      );
    }

    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(null);
    this.writeIndex = 0;
    this.size = 0;
    this.keyExtractor = keyExtractor;
    this.keyIndex = new Map();
    this.overflowCount = 0;
  }

  /**
   * Add an item to the buffer
   * If an item with the same key exists, it will be updated
   * If at capacity, the oldest item will be evicted
   */
  add(item: T): void {
    const key = this.keyExtractor(item);

    // check if item already exists, update in place
    const existingIndex = this.keyIndex.get(key);
    if (existingIndex !== undefined) {
      this.buffer[existingIndex] = item;
      return;
    }

    // evict oldest item if at capacity
    const evicted = this.buffer[this.writeIndex];
    if (evicted) {
      const evictedKey = this.keyExtractor(evicted);
      this.keyIndex.delete(evictedKey);
      this.overflowCount++;
    }

    // add new item
    this.buffer[this.writeIndex] = item;
    this.keyIndex.set(key, this.writeIndex);

    // update write index and size
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  /**
   * Get an item by its key
   */
  get(key: string): T | null {
    const index = this.keyIndex.get(key);
    if (index === undefined) return null;

    return this.buffer[index];
  }

  /**
   * Check if an item exists in the buffer
   */
  has(key: string): boolean {
    return this.keyIndex.has(key);
  }

  /**
   * Remove an item from the buffer by key
   */
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
   * Get all items in insertion order (oldest first)
   */
  getAll(): T[] {
    if (this.keyIndex.size === 0) return [];

    const result: T[] = [];

    // iterate over buffer in order of insertion
    for (let i = 0; i < this.capacity; i++) {
      // calculate index of item in buffer
      const index =
        (this.writeIndex - this.capacity + i + this.capacity) % this.capacity;
      const item = this.buffer[index];
      if (item !== null) result.push(item);
    }
    return result;
  }

  /**
   * Get the current number of items in the buffer
   */
  getSize(): number {
    return this.size;
  }

  /**
   * Get the maximum capacity
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Get the number of items that have been evicted (overflow)
   */
  getOverflowCount(): number {
    return this.overflowCount;
  }

  /**
   * Clear all items from the buffer
   */
  clear(): void {
    this.buffer = new Array(this.capacity).fill(null);
    this.keyIndex.clear();
    this.writeIndex = 0;
    this.size = 0;
    this.overflowCount = 0;
  }
}

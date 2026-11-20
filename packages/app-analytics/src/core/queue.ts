export const MAX_QUEUE_SIZE = 100;

/** A bounded FIFO queue that rejects new items when it has no capacity. */
export class BoundedQueue<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity = MAX_QUEUE_SIZE) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("Queue capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Returns the head without removing it. */
  peek(): T | undefined {
    return this.items[0];
  }

  /** Adds an item to the tail. Returns false when the new item is dropped. */
  enqueue(item: T): boolean {
    if (this.items.length >= this.capacity) return false;

    this.items.push(item);
    return true;
  }

  /** Removes up to `count` items from the head in FIFO order. */
  take(count: number): T[] {
    if (!Number.isFinite(count) || count <= 0) return [];
    return this.items.splice(0, Math.floor(count));
  }

  /**
   * Puts previously taken items back at the head without evicting queued items.
   * Returns the number of input items that could not be requeued.
   */
  requeueFront(items: readonly T[]): number {
    const available = this.capacity - this.items.length;
    const acceptedCount = Math.min(available, items.length);

    if (acceptedCount > 0) {
      this.items.unshift(...items.slice(0, acceptedCount));
    }

    return items.length - acceptedCount;
  }

  /** Removes every queued item and returns the number removed. */
  clear(): number {
    const clearedCount = this.items.length;
    this.items.length = 0;
    return clearedCount;
  }
}

/**
 * Single-producer/single-consumer async queue used by the agents plugin to
 * merge streams of SSE events from two concurrent sources: the adapter's
 * `run()` generator, and out-of-band events emitted by `executeTool` (e.g.
 * human-approval requests).
 *
 * The consumer drains the channel as an async iterable; the producer pushes
 * events synchronously and closes the channel when the source has completed
 * or errored.
 */
interface Waiter<T> {
  resolve: (value: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

export class EventChannel<T> {
  private queue: T[] = [];
  private waiters: Array<Waiter<T>> = [];
  private closed = false;
  private error: unknown = undefined;

  /** Synchronously enqueue an event. Safe to call from non-async contexts. */
  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  /**
   * Close the channel. Any pending `next()` calls resolve with `done: true`.
   * If `error` is supplied, pending `next()` calls reject with it and future
   * calls do the same.
   */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve({ value: undefined as never, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          if (this.error) return Promise.reject(this.error);
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

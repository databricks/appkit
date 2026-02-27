/**
 * Structural interface matching the SDK's `Waiter.wait()` shape
 * without importing the SDK directly.
 */
export interface Pollable<P> {
  wait(options?: {
    onProgress?: (p: P) => Promise<void>;
    timeout?: unknown;
  }): Promise<P>;
}

export type PollEvent<P> =
  | { type: "progress"; value: P }
  | { type: "completed"; value: P };

/**
 * Bridges a callback-based waiter into an async generator.
 *
 * The SDK's `waiter.wait({ onProgress })` API uses a callback to report
 * progress and returns a promise that resolves with the final result.
 * This function converts that push-based model into a pull-based async
 * generator so callers can simply `for await (const event of pollWaiter(w))`.
 *
 * Yields `{ type: "progress", value }` for each `onProgress` callback,
 * then `{ type: "completed", value }` for the final result.
 * Throws if the waiter rejects.
 */
export async function* pollWaiter<P>(
  waiter: Pollable<P>,
  options?: { timeout?: unknown },
): AsyncGenerator<PollEvent<P>> {
  const queue: P[] = [];
  let notify: () => void = () => {};
  let done = false;
  let result!: P;
  let error: unknown = null;

  waiter
    .wait({
      onProgress: async (p: P) => {
        queue.push(p);
        notify();
      },
      ...(options?.timeout != null ? { timeout: options.timeout } : {}),
    })
    .then((r) => {
      result = r;
      done = true;
      notify();
    })
    .catch((err) => {
      error = err;
      done = true;
      notify();
    });

  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const value = queue.shift() as P;
      yield { type: "progress", value };
    }

    if (!done) {
      await new Promise<void>((resolve) => {
        notify = resolve;
        if (done || queue.length > 0) resolve();
      });
    }
  }

  if (error !== null) {
    throw error;
  }

  yield { type: "completed", value: result };
}

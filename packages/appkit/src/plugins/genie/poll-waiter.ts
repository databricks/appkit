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
  // --- shared state between the onProgress callback and the generator loop ---
  const queue: P[] = []; // progress values waiting to be yielded
  let notify: () => void = () => {}; // resolves the generator's "sleep" promise
  let done = false; // true once waiter.wait() settles (success or error)
  let result!: P;
  let error: unknown = null;

  // Start the waiter in the background (not awaited — runs concurrently
  // with the generator loop below). The onProgress callback pushes values
  // into the queue and wakes the generator via notify().
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

  // Drain progress events as they arrive. The loop exits once the waiter
  // has settled AND the queue is empty.
  while (!done || queue.length > 0) {
    // Yield all queued progress values before sleeping.
    while (queue.length > 0) {
      const value = queue.shift() as P;
      yield { type: "progress", value };
    }

    // Nothing in the queue yet and the waiter hasn't settled — sleep until
    // the next onProgress call or waiter settlement wakes us via notify().
    //
    // Race-condition guard: after setting `notify = resolve`, we re-check
    // `done` and `queue.length`. If either changed between the outer while
    // check and this point (possible via microtask), we resolve immediately
    // so the loop doesn't hang.
    if (!done) {
      await new Promise<void>((resolve) => {
        notify = resolve;
        if (done || queue.length > 0) resolve();
      });
    }
  }

  // The waiter settled. If it rejected, propagate the error.
  if (error !== null) {
    throw error;
  }

  // Final event: the completed result from waiter.wait().
  yield { type: "completed", value: result };
}

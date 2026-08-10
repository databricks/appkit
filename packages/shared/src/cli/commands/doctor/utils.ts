/** Small shared helpers for the `appkit doctor` command. */

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default per-check wall-clock deadline (ms). A reachable-but-unresponsive
 * endpoint must never hang doctor — it's a CI gate that has to return. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** Thrown when a check exceeds its deadline. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Races `promise` against a wall-clock deadline, rejecting with
 * {@link TimeoutError} if it isn't settled in time. This bounds doctor even
 * when the underlying SDK/driver call has no cancellation of its own — we can't
 * abort the request, but we stop *waiting* on it so the report still returns.
 * The timer is always cleared so a fast result leaves nothing pending.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() =>
    clearTimeout(timer),
  ) as Promise<T>;
}

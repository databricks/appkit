/**
 * The cancellation shape a caller-supplied legacy-style client reads from the
 * second argument of `apiClient.request` (duck-typed, so no SDK import).
 */
interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(callback: (e?: unknown) => unknown): void;
}

/**
 * Bridges {@link AbortSignal} to a {@link CancellationToken} so
 * `apiClient.request` can abort the outbound HTTP request (and stop pulling a
 * response body) when the caller aborts.
 */
function cancellationTokenFromAbortSignal(
  signal: AbortSignal,
): CancellationToken {
  const listeners = new Set<() => void>();
  signal.addEventListener(
    "abort",
    () => {
      for (const cb of listeners) {
        try {
          cb();
        } catch {
          // ignore listener failures — abort must stay best-effort
        }
      }
    },
    { passive: true },
  );

  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(callback: (e?: unknown) => unknown) {
      listeners.add(callback as () => void);
      if (signal.aborted) {
        void callback();
      }
    },
  };
}

/**
 * Wraps an optional {@link AbortSignal} as the request context a legacy-style
 * `apiClient.request` reads (`context.cancellationToken`). Returns `undefined`
 * when no signal is given, so callers can pass the result straight through.
 */
export function contextFromAbortSignal(
  signal?: AbortSignal,
): { cancellationToken: CancellationToken } | undefined {
  return signal
    ? { cancellationToken: cancellationTokenFromAbortSignal(signal) }
    : undefined;
}

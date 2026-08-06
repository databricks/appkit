import { type CancellationToken, Context } from "../workspace-client";

/**
 * Bridges {@link AbortSignal} to the SDK's {@link CancellationToken} so
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
 * Wraps an optional {@link AbortSignal} in an SDK {@link Context} for the
 * second argument of `apiClient.request`. Returns `undefined` when no signal
 * is given, so callers can pass the result straight through.
 */
export function contextFromAbortSignal(
  signal?: AbortSignal,
): InstanceType<typeof Context> | undefined {
  return signal
    ? new Context({
        cancellationToken: cancellationTokenFromAbortSignal(signal),
      })
    : undefined;
}

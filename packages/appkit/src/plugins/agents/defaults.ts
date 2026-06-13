import type { StreamExecutionSettings } from "shared";

export const agentStreamDefaults: StreamExecutionSettings = {
  default: {
    cache: { enabled: false },
    // Conservative retry for transient serving errors (5xx / 429 / connection
    // resets) — see `isRetryableError` in plugin/interceptors/retry.ts; 4xx and
    // non-retryable AppKitErrors are never retried.
    //
    // SAFETY: this is streaming-replay-safe by construction. In
    // `executeStream`, the RetryInterceptor wraps only the *creation* of the
    // adapter async generator (`fn()` returns the generator object
    // synchronously, without running its body). Token emission and tool
    // dispatch happen during `yield*` iteration, which runs *outside* the
    // interceptor chain. So a transient error thrown after the first streamed
    // event surfaces during iteration and is never retried — there is no path
    // by which retry can re-emit tokens or re-run a tool side-effect. Only a
    // failure during generator setup (before any output) is retried.
    retry: { enabled: true, attempts: 2, initialDelay: 500, maxDelay: 4_000 },
    timeout: 300_000,
  },
  stream: {
    bufferSize: 200,
  },
};

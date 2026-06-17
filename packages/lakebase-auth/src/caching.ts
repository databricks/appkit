import type { FetchCredential, LogFn } from "./types";

/**
 * Delay before retrying a background (eager) refresh that failed even after
 * the inner {@link withRetries} schedule was exhausted.
 */
const BACKGROUND_RETRY_MS = 5000;

/** A cached token source with a disposer to release any background timers. */
export interface CachedTokenProvider {
  /** Resolve to a valid token, refreshing if necessary. */
  getToken: () => Promise<string>;
  /** Stop any scheduled background refresh (idempotent). */
  dispose: () => void;
}

/**
 * Eagerly cache a token, refreshing it in the background before it expires.
 *
 * A first fetch is kicked off immediately (not awaited) and subsequent
 * refreshes are scheduled via an `unref`'d timer, so the token is kept warm
 * without holding the event loop open. If a background refresh fails it is
 * retried after a short delay. {@link CachedTokenProvider.getToken} returns the
 * cached token while valid and otherwise falls back to an on-demand refresh.
 *
 * @param fetchCredential Fetches a fresh credential (typically retry-wrapped)
 * @param earlyRefreshMs How long before expiry to refresh
 * @param onLog Optional structured logging callback
 */
export function cachedWithTimedRefresh(
  fetchCredential: FetchCredential,
  earlyRefreshMs: number,
  onLog?: LogFn,
): CachedTokenProvider {
  let cachedToken = "";
  let expiresAt = 0;
  let inFlight: Promise<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function scheduleNext(delayMs: number): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        // Background refresh: swallow rejection here (getToken surfaces errors
        // to callers); failures reschedule themselves below.
        refresh().catch(() => {});
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
  }

  function refresh(): Promise<string> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { token, expiresAt: exp } = await fetchCredential();
        cachedToken = token;
        expiresAt = exp;
        scheduleNext(exp - Date.now() - earlyRefreshMs);
        return token;
      } catch (err) {
        onLog?.(
          "warn",
          "Background token refresh failed, retrying in %dms: %s",
          BACKGROUND_RETRY_MS,
          err instanceof Error ? err.message : String(err),
        );
        scheduleNext(BACKGROUND_RETRY_MS);
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  // Kick off the eager fetch immediately. Swallow the rejection so an initial
  // failure doesn't surface as an unhandled rejection; getToken re-triggers.
  refresh().catch(() => {});

  return {
    getToken() {
      if (cachedToken && Date.now() < expiresAt - earlyRefreshMs) {
        return Promise.resolve(cachedToken);
      }
      return refresh();
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

const PAST_EPOCH = Number.NEGATIVE_INFINITY;
const FAR_FUTURE_EPOCH = Number.POSITIVE_INFINITY;

/**
 * Lazily cache a token, refreshing it on demand when it nears expiry.
 *
 * The first call triggers a fetch; concurrent callers share the same in-flight
 * promise (deduplication). A failed refresh resets the cache so the next call
 * retries rather than serving a rejected promise indefinitely.
 *
 * @param fetchCredential Fetches a fresh credential (typically retry-wrapped)
 * @param earlyRefreshMs How long before expiry to refresh
 */
export function cachedWithOnDemandRefresh(
  fetchCredential: FetchCredential,
  earlyRefreshMs: number,
): CachedTokenProvider {
  let refreshAfter = PAST_EPOCH; // first call must refresh
  let cachedToken: Promise<string> = Promise.resolve("");

  async function refresh(): Promise<string> {
    refreshAfter = FAR_FUTURE_EPOCH; // dedupe: no more refreshes until done
    try {
      const { token, expiresAt } = await fetchCredential();
      refreshAfter = expiresAt - earlyRefreshMs;
      return token;
    } catch (err) {
      refreshAfter = PAST_EPOCH; // allow the next call to retry
      throw err;
    }
  }

  return {
    getToken() {
      if (Date.now() > refreshAfter) cachedToken = refresh();
      return cachedToken;
    },
    dispose() {
      // No background timers to clean up in lazy mode.
    },
  };
}

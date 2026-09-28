/**
 * Generic keyed request store: coalesces identical in-flight requests so N
 * subscribers of the same key share one run, and fans state updates back out
 * via `useSyncExternalStore`.
 *
 * Owns only the lifecycle — refcount, deferred teardown, subscribe/notify — and
 * is transport-agnostic: the caller's `run` performs the actual fetch (SSE,
 * Arrow, plain fetch, …) and reports state through `controls.patch`. The
 * snapshot type `S` and its reset policy live entirely with the caller.
 *
 * Dedup-only: an entry lives exactly as long as it has subscribers. When the
 * last one releases, teardown is deferred a tick (so a React StrictMode
 * unmount→remount reuses the in-flight request instead of aborting it); if no
 * one re-subscribes by then, the request is aborted and the entry dropped.
 */

/** What a `run` uses to drive its request and report state. */
export interface RequestControls<S> {
  /** Aborted when the request is superseded or torn down. */
  signal: AbortSignal;
  /** Abort this run's transport (e.g. to close a stream on a fatal frame). */
  abort(): void;
  /** Merge fields into the entry's snapshot and notify subscribers. */
  patch(next: Partial<S>): void;
}

/**
 * Starts a request and reports state through `controls`. It may return a
 * promise that settles once the run has reported its outcome or was aborted;
 * `restartStarted` waits on it. It must not reject.
 */
export type RequestRunner<S> = (
  controls: RequestControls<S>,
) => void | Promise<void>;

/** How `retain` creates an entry; ignored when the entry already exists. */
export interface RetainOptions<M> {
  /** Start the request on creation. Default true. */
  autoStart?: boolean;
  /** Caller data kept with the entry and handed to `restartStarted`'s match. */
  meta?: M;
}

interface RequestStore<S, M> {
  /**
   * Register a subscriber for `key`, creating and starting the shared request
   * on first use. Returns a `release` function to call on unmount.
   *
   * @param run     Runs the request; stored on the entry and re-invoked by
   *   `start`. Only the first caller's `run` is used (later joiners share it).
   * @param options `autoStart` and `meta`, both taken from the first caller.
   */
  retain(
    key: string,
    run: RequestRunner<S>,
    options?: RetainOptions<M>,
  ): () => void;
  /** (Re)start the request for `key`: abort any in-flight run, then re-run. */
  start(key: string): void;
  /**
   * `start` every subscribed entry that has run at least once and that
   * `match` accepts (every such entry without one), then resolve once each
   * restarted run settles. An entry retained with `autoStart: false` that
   * never ran stays idle, and one whose last subscriber left is not restarted.
   */
  restartStarted(
    match?: (key: string, meta: M | undefined) => boolean,
  ): Promise<void>;
  subscribe(key: string, listener: () => void): () => void;
  getSnapshot(key: string): S;
  /** Test-only: abort every in-flight request and clear the store. */
  reset(): void;
}

interface Entry<S, M> {
  snapshot: S;
  meta: M | undefined;
  refCount: number;
  abortController: AbortController | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  /** True once `start` has run at least once; guards re-run on late `retain`. */
  started: boolean;
  run: RequestRunner<S>;
}

export function createRequestStore<S, M = never>(idle: S): RequestStore<S, M> {
  const entries = new Map<string, Entry<S, M>>();

  // Keyed separately from `entries`: `subscribe` can run before `retain`
  // creates the entry, so listeners must survive independently of entry life.
  const listenersByKey = new Map<string, Set<() => void>>();

  function notify(key: string): void {
    const listeners = listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }

  /** Run `key` again; resolves when that run settles (at once for a void run). */
  function run(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return Promise.resolve();

    entry.abortController?.abort();
    entry.started = true;

    const abortController = new AbortController();
    entry.abortController = abortController;

    const settled = entry.run({
      signal: abortController.signal,
      abort: () => abortController.abort(),
      patch(next) {
        entry.snapshot = { ...entry.snapshot, ...next };
        notify(key);
      },
    });
    // A runner must not reject; guard anyway so a restart never does.
    return Promise.resolve(settled).catch(() => {});
  }

  function start(key: string): void {
    void run(key);
  }

  function release(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    // Defer teardown one tick: a StrictMode unmount→remount (or fast route
    // swap) re-`retain`s within the same tick and reuses the request.
    entry.teardownTimer = setTimeout(() => {
      const current = entries.get(key);
      if (!current || current.refCount > 0) return;
      current.abortController?.abort();
      entries.delete(key);
    }, 0);
  }

  return {
    retain(key, runner, { autoStart = true, meta } = {}) {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          snapshot: idle,
          meta,
          refCount: 0,
          abortController: null,
          teardownTimer: null,
          started: false,
          run: runner,
        };
        entries.set(key, entry);
      }

      // A late joiner cancels any pending teardown so it keeps the live request.
      if (entry.teardownTimer !== null) {
        clearTimeout(entry.teardownTimer);
        entry.teardownTimer = null;
      }
      entry.refCount += 1;

      if (autoStart && !entry.started) {
        start(key);
      }

      return () => release(key);
    },

    start,

    async restartStarted(match) {
      // Collect first: a restarted run patches, and a patch notifies. An entry
      // with no subscriber is waiting for teardown; restarting it would only
      // send a request that teardown aborts a tick later.
      const keys = [...entries]
        .filter(
          ([key, entry]) =>
            entry.started &&
            entry.refCount > 0 &&
            (!match || match(key, entry.meta)),
        )
        .map(([key]) => key);
      await Promise.all(keys.map(run));
    },

    subscribe(key, listener) {
      let listeners = listenersByKey.get(key);
      if (!listeners) {
        listeners = new Set();
        listenersByKey.set(key, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersByKey.delete(key);
      };
    },

    getSnapshot(key) {
      return entries.get(key)?.snapshot ?? idle;
    },

    reset() {
      for (const entry of entries.values()) {
        if (entry.teardownTimer !== null) clearTimeout(entry.teardownTimer);
        entry.abortController?.abort();
      }
      entries.clear();
      listenersByKey.clear();
    },
  };
}

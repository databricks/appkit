import type { WorkspaceClient } from "@databricks/sdk-experimental";

/**
 * Lifecycle states a SQL warehouse can report. Mirrors the Databricks SDK
 * `State` union; redeclared here so callers of this module don't need to reach
 * into the SDK's deep type paths.
 */
export type WarehouseState =
  | "RUNNING"
  | "STARTING"
  | "STOPPED"
  | "STOPPING"
  | "DELETING"
  | "DELETED";

/** Backoff bounds for {@link waitUntilRunning}. */
const INITIAL_POLL_MS = 1000;
const MAX_POLL_MS = 15000;

/**
 * `name` on the Error {@link waitUntilRunning} throws when its deadline elapses
 * before the warehouse reaches RUNNING. Exported so callers can distinguish a
 * genuine wait-timeout (worth a dedicated, sanitized message) from any other
 * failure surfaced during polling (connectivity/auth), without string-matching
 * the message — whose `(last state: …)` detail should never reach end users.
 */
export const WAREHOUSE_WAIT_TIMEOUT = "WarehouseWaitTimeoutError";

/** States from which the warehouse will not transition to RUNNING on its own. */
const NOT_COMING_UP: ReadonlySet<WarehouseState> = new Set<WarehouseState>([
  "STOPPED",
  "STOPPING",
  "DELETED",
  "DELETING",
]);

/**
 * Terminal states even when {@link waitUntilRunning} is told to treat
 * STOPPED/STOPPING as transient: a deleted (or deleting) warehouse genuinely
 * can't reach RUNNING, so we still resolve with the observed state.
 */
const NEVER_COMING_UP: ReadonlySet<WarehouseState> = new Set<WarehouseState>([
  "DELETED",
  "DELETING",
]);

/**
 * Sleep for `ms`, resolving early if `signal` aborts. The pending timer is
 * always cleared (on resolve and on abort) so a long backoff can't keep the
 * event loop alive after the caller has bailed.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fetch the current lifecycle state of a SQL warehouse.
 *
 * Errors from the SDK (auth, bad warehouse id, connectivity) are intentionally
 * NOT caught — the caller decides how to classify and react to them.
 */
export async function getWarehouseState(
  client: WorkspaceClient,
  warehouseId: string,
): Promise<WarehouseState> {
  const response = await client.warehouses.get({ id: warehouseId });
  return response.state as WarehouseState;
}

/**
 * Initiate a start of a stopped/stopping SQL warehouse.
 *
 * Only KICKS OFF the start: the SDK's `start()` returns a Waiter, but we
 * deliberately do not `.wait()` on it. Blocking on the full cold-start isn't our
 * job here — {@link waitUntilRunning} is the poller that watches the warehouse
 * the rest of the way to RUNNING. We just nudge it out of the stopped state.
 *
 * Errors from the SDK (auth, bad warehouse id, connectivity) are intentionally
 * NOT caught — the caller decides how to classify and react to them.
 */
export async function startWarehouse(
  client: WorkspaceClient,
  warehouseId: string,
): Promise<void> {
  await client.warehouses.start({ id: warehouseId });
}

/**
 * Poll a warehouse until it reaches RUNNING, settles into a state it won't
 * leave on its own, or a deadline elapses.
 *
 * Polling uses exponential backoff: the first wait is ~{@link INITIAL_POLL_MS},
 * doubling on each subsequent poll up to a ~{@link MAX_POLL_MS} cap.
 *
 * Resolution:
 *  - Resolves `"RUNNING"` as soon as the warehouse is running.
 *  - Resolves with the observed state if it reaches a not-coming-up state
 *    (`STOPPED`/`STOPPING`/`DELETED`/`DELETING`) — the caller decides what to do.
 *
 * Set `opts.treatStoppedAsTransient` when the caller has just issued a start and
 * a still-`STOPPED`/`STOPPING` reading is expected to be a stale pre-start blip
 * rather than a settled state. With it on, those two states are polled through
 * (like `STARTING`) until RUNNING, a genuinely terminal `DELETED`/`DELETING`, or
 * the deadline — so an immediate post-start STOPPED reading no longer bails the
 * wait. Off (default), STOPPED/STOPPING remain terminal and resolve as before.
 *
 * Pass `opts.signal` to abort an in-progress wait (e.g. a dev server shutting
 * down): the next deadline/abort check throws an `AbortError`, and a pending
 * backoff sleep resolves immediately rather than holding the process open.
 *
 * Pass `opts.report` to surface a single "still waiting" line to the caller (a
 * cold start can take minutes; without it a `--wait` build looks hung). It is
 * invoked EXACTLY ONCE, before the first poll/sleep, and only when the first
 * read is not already RUNNING/terminal — i.e. only when we're actually about to
 * wait. The library stays pure: the message is handed to a caller-supplied sink
 * (console for the CLI, `logger.debug`/no-op for dev), never written here.
 *
 * @throws Error if `maxMs` elapses before the warehouse reaches RUNNING.
 * @throws Error (`name === "AbortError"`) if `opts.signal` is or becomes aborted.
 */
export async function waitUntilRunning(
  client: WorkspaceClient,
  warehouseId: string,
  opts: {
    maxMs: number;
    pollMs?: number;
    signal?: AbortSignal;
    treatStoppedAsTransient?: boolean;
    report?: (msg: string) => void;
  },
): Promise<WarehouseState> {
  const { maxMs, signal, treatStoppedAsTransient, report } = opts;
  const start = Date.now();
  let pollMs = opts.pollMs ?? INITIAL_POLL_MS;

  // Which states end the wait early. When we've just issued a start, STOPPED and
  // STOPPING are expected stale readings, so only DELETED/DELETING stay terminal.
  const terminalStates = treatStoppedAsTransient
    ? NEVER_COMING_UP
    : NOT_COMING_UP;

  // Fire the "still waiting" notice at most once, and only once we know the first
  // read settled into an actual wait (not already RUNNING/terminal). Hoisted so
  // the guard survives every loop iteration.
  let reported = false;

  while (true) {
    throwIfAborted(signal);

    const state = await getWarehouseState(client, warehouseId);
    if (state === "RUNNING") return "RUNNING";
    if (terminalStates.has(state)) return state;

    // First non-terminal read: we're committing to wait, so tell the caller once
    // before the very first backoff sleep. Subsequent polls stay quiet.
    if (!reported) {
      reported = true;
      report?.(
        `Waiting for warehouse ${warehouseId} to reach RUNNING (up to ${Math.round(
          maxMs / 1000,
        )}s)…`,
      );
    }

    if (Date.now() - start >= maxMs) {
      throw timeoutError(warehouseId, maxMs, state);
    }

    await delay(pollMs, signal);
    throwIfAborted(signal);

    // Re-check the deadline after sleeping so we don't issue another poll past
    // the budget purely because we napped through it.
    if (Date.now() - start >= maxMs) {
      throw timeoutError(warehouseId, maxMs, state);
    }

    pollMs = Math.min(pollMs * 2, MAX_POLL_MS);
  }
}

/** Throw a DOMException-style AbortError if the signal has been aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("The warehouse wait was aborted.");
  error.name = "AbortError";
  throw error;
}

/**
 * Build the deadline-elapsed error, tagged with {@link WAREHOUSE_WAIT_TIMEOUT}
 * so callers can recognise a genuine timeout (vs. a connectivity/auth failure
 * thrown mid-poll) without parsing the message. The message keeps the last
 * observed state for debug/log use; callers that surface text to end users
 * should compose their own sanitized message instead.
 */
function timeoutError(
  warehouseId: string,
  maxMs: number,
  lastState: WarehouseState,
): Error {
  const error = new Error(
    `Warehouse ${warehouseId} did not reach RUNNING within ${maxMs}ms (last state: ${lastState})`,
  );
  error.name = WAREHOUSE_WAIT_TIMEOUT;
  return error;
}

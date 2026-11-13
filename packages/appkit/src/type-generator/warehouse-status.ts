import type { WorkspaceClient } from "../workspace-client";

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
 * Default limit (5 min) on how long a `--wait` run waits for the SQL warehouse
 * to reach RUNNING. Long enough for a typical cold start; short enough that a
 * warehouse stuck in STARTING can't hang a build.
 */
export const DEFAULT_WAREHOUSE_WAIT_TIMEOUT_MS = 300_000;

/**
 * Env var that sets the warehouse wait limit, in seconds. The CLI's
 * `--wait-timeout <seconds>` flag takes precedence over it.
 */
export const WAREHOUSE_WAIT_TIMEOUT_ENV = "APPKIT_TYPEGEN_WAIT_TIMEOUT";

/**
 * Error code shared by every surface that reports a warehouse that could not
 * serve type generation in time (typegen, deploy checks, deploy docs).
 */
export const WAREHOUSE_UNAVAILABLE_CODE = "warehouse_unavailable";

/**
 * Cap on a single `warehouses.get` made outside a wait (the preflight status
 * check), so an API that never answers can't hang the run either. Polls inside
 * {@link waitUntilRunning} are bounded by the remaining wait budget instead.
 */
const STATUS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Lower bound for the preflight status check, so a very short (or `0`) wait
 * limit still leaves time for one answer from the API.
 */
const MIN_STATUS_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Time allowed for the preflight status check given the wait budget left:
 * the budget, but at least {@link MIN_STATUS_REQUEST_TIMEOUT_MS} and at most
 * {@link STATUS_REQUEST_TIMEOUT_MS}.
 */
export function statusRequestTimeoutMs(remainingMs: number): number {
  return Math.min(
    STATUS_REQUEST_TIMEOUT_MS,
    Math.max(remainingMs, MIN_STATUS_REQUEST_TIMEOUT_MS),
  );
}

/**
 * Thrown by {@link getWarehouseState} / {@link startWarehouse} when the
 * warehouse API doesn't answer within `timeoutMs`. The request is aborted.
 */
export class WarehouseStatusTimeoutError extends Error {
  readonly code = WAREHOUSE_UNAVAILABLE_CODE;
  readonly warehouseId: string;
  readonly timeoutMs: number;
  readonly request: "status" | "start";

  constructor(
    warehouseId: string,
    timeoutMs: number,
    request: "status" | "start" = "status",
  ) {
    super(
      `Warehouse ${warehouseId} did not answer a ${request} request within ${timeoutMs}ms`,
    );
    this.name = "WarehouseStatusTimeoutError";
    this.warehouseId = warehouseId;
    this.timeoutMs = timeoutMs;
    this.request = request;
  }
}

/** One-line, user-facing description of a warehouse API request timeout. */
export function describeStatusTimeout(
  error: WarehouseStatusTimeoutError,
): string {
  return `${WAREHOUSE_UNAVAILABLE_CODE}: warehouse ${error.warehouseId} did not answer a ${error.request} request within ${formatWaitLimit(error.timeoutMs)}`;
}

/**
 * Run a warehouse API call that must settle within `timeoutMs`. The call gets
 * an AbortSignal (aborted on timeout or when `signal` aborts); the deadline is
 * enforced here as well, so it holds even if a transport ignores the signal.
 */
async function withRequestDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  opts: {
    warehouseId: string;
    request: "status" | "start";
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<T> {
  const { timeoutMs, signal } = opts;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    if (timeoutMs === undefined) return;
    timer = setTimeout(
      () => {
        controller.abort();
        reject(
          new WarehouseStatusTimeoutError(
            opts.warehouseId,
            timeoutMs,
            opts.request,
          ),
        );
      },
      Math.max(0, timeoutMs),
    );
  });

  // Async wrapper: a synchronous throw or a non-promise result still settles
  // the race like any other answer.
  const request = (async () => call(controller.signal))();
  // Once the deadline wins, the aborted request's rejection is expected noise.
  request.catch(() => {});

  try {
    return await Promise.race([request, timedOut]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Thrown by {@link waitUntilRunning} when the warehouse does not reach RUNNING
 * within the wait limit. Carries what the user needs to act on: the warehouse,
 * the last state it reported (if any) and the limit that ran out.
 */
export class WarehouseWaitTimeoutError extends Error {
  readonly code = WAREHOUSE_UNAVAILABLE_CODE;
  readonly warehouseId: string;
  /** Last state reported; `undefined` if no status request was answered. */
  readonly lastState: WarehouseState | undefined;
  readonly timeoutMs: number;

  constructor(
    warehouseId: string,
    lastState: WarehouseState | undefined,
    timeoutMs: number,
  ) {
    super(
      `Warehouse ${warehouseId} did not reach RUNNING within ${timeoutMs}ms (last state: ${lastState ?? "unknown, status request did not answer"})`,
    );
    this.name = "WarehouseWaitTimeoutError";
    this.warehouseId = warehouseId;
    this.lastState = lastState;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * One-line, user-facing description of a wait timeout, prefixed with the
 * shared {@link WAREHOUSE_UNAVAILABLE_CODE} so logs can be matched on it.
 * `limitMs` is the limit to report — the full configured limit, which can be
 * larger than the remainder a later wait in the same run was given.
 */
export function describeWaitTimeout(
  error: WarehouseWaitTimeoutError,
  limitMs: number = error.timeoutMs,
): string {
  const state = error.lastState
    ? `is still ${error.lastState}`
    : "did not answer a status request";
  return `${WAREHOUSE_UNAVAILABLE_CODE}: warehouse ${error.warehouseId} ${state} after the ${formatWaitLimit(limitMs)} wait limit`;
}

/**
 * Milliseconds left before `deadline` (epoch ms), or `limitMs` when no shared
 * deadline was given. Lets one `--wait` run spend a single wait budget across
 * the query and metric-view paths instead of one budget each.
 */
export function remainingWaitMs(limitMs: number, deadline?: number): number {
  if (deadline === undefined) return limitMs;
  return Math.max(0, deadline - Date.now());
}

/** Format a millisecond limit for humans: whole seconds when it divides evenly. */
function formatWaitLimit(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/**
 * Resolve the warehouse wait limit in milliseconds.
 *
 * Precedence: an explicit `waitTimeoutMs` (the CLI flag, or a library caller),
 * then {@link WAREHOUSE_WAIT_TIMEOUT_ENV} (seconds), then
 * {@link DEFAULT_WAREHOUSE_WAIT_TIMEOUT_MS}. `0` is valid and means "check
 * once, don't wait". An invalid env value is ignored with a warning rather
 * than failing the build.
 */
export function resolveWarehouseWaitTimeoutMs(
  waitTimeoutMs?: number,
  onInvalidEnv?: (raw: string) => void,
): number {
  if (
    typeof waitTimeoutMs === "number" &&
    Number.isFinite(waitTimeoutMs) &&
    waitTimeoutMs >= 0
  ) {
    return Math.floor(waitTimeoutMs);
  }

  const raw = process.env[WAREHOUSE_WAIT_TIMEOUT_ENV]?.trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.floor(seconds * 1000);
    }
    onInvalidEnv?.(raw);
  }

  return DEFAULT_WAREHOUSE_WAIT_TIMEOUT_MS;
}

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
 * Pass `opts.timeoutMs` to bound the request: if it hasn't answered by then it
 * is aborted and a {@link WarehouseStatusTimeoutError} is thrown. The bound is
 * enforced here, not just handed to the SDK, so it holds even if a transport
 * ignores the signal. `opts.signal` cancels the request too.
 *
 * Errors from the SDK (auth, bad warehouse id, connectivity) are intentionally
 * NOT caught — the caller decides how to classify and react to them.
 */
export async function getWarehouseState(
  client: WorkspaceClient,
  warehouseId: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WarehouseState> {
  if (opts.timeoutMs === undefined && opts.signal === undefined) {
    const response = await client.warehouses.getWarehouse({ id: warehouseId });
    return response.state as WarehouseState;
  }
  const response = await withRequestDeadline(
    (signal) => client.warehouses.getWarehouse({ id: warehouseId }, { signal }),
    { warehouseId, request: "status", ...opts },
  );
  return response.state as WarehouseState;
}

/**
 * Initiate a start of a stopped/stopping SQL warehouse.
 *
 * Only KICKS OFF the start: the SDK's `startWarehouse()` returns a Waiter, but we
 * deliberately do not `.wait()` on it. Blocking on the full cold-start isn't our
 * job here — {@link waitUntilRunning} is the poller that watches the warehouse
 * the rest of the way to RUNNING. We just nudge it out of the stopped state.
 *
 * Pass `opts.timeoutMs` to bound the request (see {@link getWarehouseState}).
 *
 * Errors from the SDK (auth, bad warehouse id, connectivity) are intentionally
 * NOT caught — the caller decides how to classify and react to them.
 */
export async function startWarehouse(
  client: WorkspaceClient,
  warehouseId: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  if (opts.timeoutMs === undefined) {
    await client.warehouses.startWarehouse({ id: warehouseId });
    return;
  }
  await withRequestDeadline(
    (signal) =>
      client.warehouses.startWarehouse({ id: warehouseId }, { signal }),
    { warehouseId, request: "start", timeoutMs: opts.timeoutMs },
  );
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
 * Backoff sleeps never run past the deadline, and each `warehouses.get` is
 * bounded by the budget left, so the wait settles within `maxMs` even when a
 * status request never answers.
 *
 * @throws WarehouseWaitTimeoutError if `maxMs` elapses before the warehouse
 *   reaches RUNNING.
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
    /** State the caller already observed, reported if no poll answers. */
    lastKnownState?: WarehouseState;
  },
): Promise<WarehouseState> {
  const { maxMs, signal, treatStoppedAsTransient } = opts;
  const start = Date.now();
  let pollMs = opts.pollMs ?? INITIAL_POLL_MS;
  let lastState = opts.lastKnownState;

  // Which states end the wait early. When we've just issued a start, STOPPED and
  // STOPPING are expected stale readings, so only DELETED/DELETING stay terminal.
  const terminalStates = treatStoppedAsTransient
    ? NEVER_COMING_UP
    : NOT_COMING_UP;

  while (true) {
    throwIfAborted(signal);

    // Each poll gets only what's left of the budget, so a status request that
    // never answers can't hold the wait past the limit.
    let state: WarehouseState;
    try {
      state = await getWarehouseState(client, warehouseId, {
        timeoutMs: Math.max(0, maxMs - (Date.now() - start)),
        signal,
      });
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof WarehouseStatusTimeoutError) {
        throw new WarehouseWaitTimeoutError(warehouseId, lastState, maxMs);
      }
      throw error;
    }
    lastState = state;
    if (state === "RUNNING") return "RUNNING";
    if (terminalStates.has(state)) return state;

    const remaining = maxMs - (Date.now() - start);
    if (remaining <= 0) {
      throw new WarehouseWaitTimeoutError(warehouseId, state, maxMs);
    }

    // Never sleep past the deadline: wake at it and make one last check.
    await delay(Math.min(pollMs, remaining), signal);
    throwIfAborted(signal);

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

import { EventEmitter } from "node:events";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WarehouseState } from "../warehouse-status";

const mocks = vi.hoisted(() => ({
  generateFromEntryPoint: vi.fn(),
  getWarehouseState: vi.fn(),
  startWarehouse: vi.fn(),
  waitUntilRunning: vi.fn(),
  // Counts `new WorkspaceClient({})` constructions so the per-save perf tests can
  // assert the watch builds exactly one client (not one per rapid save).
  workspaceClientCtor: vi.fn(),
}));

// Mock the module vite-plugin.ts pulls generateFromEntryPoint from. The error
// classes are imported for `instanceof` checks in the catch block, so they must
// remain real constructors — only the warehouse-touching entry point is spied.
vi.mock("../index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../index")>();
  return {
    ...actual,
    generateFromEntryPoint: mocks.generateFromEntryPoint,
  };
});

// Mock the warehouse-status helpers so the background watch is fully driven by
// the test (no real WorkspaceClient / SDK calls).
vi.mock("../warehouse-status", () => ({
  getWarehouseState: mocks.getWarehouseState,
  startWarehouse: mocks.startWarehouse,
  waitUntilRunning: mocks.waitUntilRunning,
}));

// armWarehouseWatch constructs `new WorkspaceClient({})`. Stub the SDK so that
// constructor is inert in unit tests, but route each construction through a spy
// so the per-save perf tests can count how many clients the watch builds.
vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: class {
    constructor() {
      mocks.workspaceClientCtor();
    }
  },
}));

const { appKitTypesPlugin } = await import("../vite-plugin");

// The plugin hooks are loosely typed on Vite's Plugin; cast to the shapes we
// actually drive so we can call them directly without a Vite build.
type ConfigResolvedHook = (config: { root: string }) => void;
type BuildStartHook = () => unknown;
type ConfigureServerHook = (server: ViteDevServer) => void;

function getHook<T>(
  plugin: Plugin,
  name: "configResolved" | "buildStart" | "configureServer",
): T {
  const hook = plugin[name];
  if (typeof hook !== "function") {
    throw new Error(`expected ${name} to be a function hook`);
  }
  return hook as T;
}

/**
 * A deferred promise whose settlement the test controls — used to hold a
 * generateFromEntryPoint call "in flight" while a second trigger arrives, so we
 * can observe single-flight coalescing deterministically.
 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Construct the plugin and drive configResolved so outFile/watchFolders set. */
function makeConfiguredPlugin() {
  const plugin = appKitTypesPlugin();
  const configResolved = getHook<ConfigResolvedHook>(plugin, "configResolved");
  // configResolved derives outFile/watchFolders from config.root; a client
  // sub-folder mirrors the real layout (projectRoot = config.root/..).
  configResolved({ root: path.join(process.cwd(), "client") });
  return plugin;
}

/** Drive configResolved + buildStart so generate() runs to the spy. */
async function runPlugin() {
  const plugin = makeConfiguredPlugin();
  const buildStart = getHook<BuildStartHook>(plugin, "buildStart");
  await buildStart();
}

/**
 * Minimal ViteDevServer stand-in: a chokidar-like `watcher` (EventEmitter with
 * a no-op `add`) plus an `httpServer` EventEmitter so the close-cleanup hook can
 * register. Returns the doubles so tests can emit "change"/"close".
 */
function makeFakeServer() {
  const watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
  const httpServer = new EventEmitter();
  const server = { watcher, httpServer } as unknown as ViteDevServer;
  return { server, watcher, httpServer };
}

/**
 * Settle the microtask queue so awaited generate/watch chains progress. The
 * background watch threads several awaits (getWarehouseState → waitUntilRunning
 * → runGenerate → generateOnce → generateFromEntryPoint), so drain generously.
 */
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

describe("appKitTypesPlugin — generation mode", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedWarehouseId = process.env.DATABRICKS_WAREHOUSE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateFromEntryPoint.mockResolvedValue(undefined);
    // Default the warehouse watch to a no-op so tests that don't exercise it
    // aren't perturbed by a background regenerate. DELETED is the only state the
    // watch leaves alone (it can't be started and blocking would be fatal), so
    // it never starts/waits/regenerates — unlike RUNNING, which now describes in
    // the background.
    mocks.getWarehouseState.mockResolvedValue("DELETED" as WarehouseState);
    mocks.startWarehouse.mockResolvedValue(undefined);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);
    // A non-empty warehouse ID is required or generate() short-circuits before
    // ever calling generateFromEntryPoint.
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-test";
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;

    if (savedWarehouseId === undefined)
      delete process.env.DATABRICKS_WAREHOUSE_ID;
    else process.env.DATABRICKS_WAREHOUSE_ID = savedWarehouseId;
  });

  test('foreground passes mode: "non-blocking" when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = "development";

    await runPlugin();

    // Dev foreground degrades instantly: it never blocks and never describes.
    // (The warehouse watch is a DELETED no-op here, so there's no background
    // regenerate — exactly one foreground call.)
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "non-blocking" }),
    );
  });

  test('passes mode: "blocking" when NODE_ENV is production', async () => {
    process.env.NODE_ENV = "production";

    await runPlugin();

    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "blocking" }),
    );
  });

  test("skips generation when warehouse ID is absent", async () => {
    delete process.env.DATABRICKS_WAREHOUSE_ID;

    await runPlugin();

    expect(mocks.generateFromEntryPoint).not.toHaveBeenCalled();
  });
});

describe("appKitTypesPlugin — single-flight generate", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedWarehouseId = process.env.DATABRICKS_WAREHOUSE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    // Watch is a no-op here (DELETED leaves the degraded types alone) so it can't
    // add stray generate calls — RUNNING would now describe in the background.
    mocks.getWarehouseState.mockResolvedValue("DELETED" as WarehouseState);
    mocks.startWarehouse.mockResolvedValue(undefined);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);
    process.env.NODE_ENV = "development";
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-test";
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;

    if (savedWarehouseId === undefined)
      delete process.env.DATABRICKS_WAREHOUSE_ID;
    else process.env.DATABRICKS_WAREHOUSE_ID = savedWarehouseId;
  });

  test("coalesces overlapping triggers into one in-flight + one trailing run", async () => {
    // First generate hangs on a deferred; while it's in flight we fire two more
    // triggers. They must NOT start concurrently — they collapse into a single
    // trailing run after the first settles.
    const first = deferred();
    const second = deferred();
    mocks.generateFromEntryPoint
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const plugin = makeConfiguredPlugin();
    const { server, watcher } = makeFakeServer();
    const configureServer = getHook<ConfigureServerHook>(
      plugin,
      "configureServer",
    );
    const buildStart = getHook<BuildStartHook>(plugin, "buildStart");

    configureServer(server);

    // Trigger 1: the initial build. Starts generate #1 (now in flight).
    await buildStart();
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);

    const sqlFile = path.join(process.cwd(), "config", "queries", "q.sql");
    // Triggers 2 and 3 arrive while #1 is still in flight: no new run starts.
    watcher.emit("change", sqlFile);
    watcher.emit("change", sqlFile);
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);

    // Settle #1 → exactly ONE trailing run fires for the coalesced triggers.
    first.resolve();
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);

    // Settle the trailing run; no further runs queued.
    second.resolve();
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);
  });

  test("a trigger after the previous run settled starts a fresh run", async () => {
    mocks.generateFromEntryPoint.mockResolvedValue(undefined);

    const plugin = makeConfiguredPlugin();
    const { server, watcher } = makeFakeServer();
    getHook<ConfigureServerHook>(plugin, "configureServer")(server);
    const buildStart = getHook<BuildStartHook>(plugin, "buildStart");

    await buildStart();
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);

    // Nothing in flight now: a later .sql change runs generate again.
    watcher.emit(
      "change",
      path.join(process.cwd(), "config", "queries", "q.sql"),
    );
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);
  });
});

describe("appKitTypesPlugin — background warehouse watch", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedWarehouseId = process.env.DATABRICKS_WAREHOUSE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateFromEntryPoint.mockResolvedValue(undefined);
    mocks.startWarehouse.mockResolvedValue(undefined);
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-test";
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;

    if (savedWarehouseId === undefined)
      delete process.env.DATABRICKS_WAREHOUSE_ID;
    else process.env.DATABRICKS_WAREHOUSE_ID = savedWarehouseId;
  });

  test("STOPPED → starts the warehouse, then RUNNING regenerates in dev", async () => {
    process.env.NODE_ENV = "development";
    // Warehouse is stopped; the watch must kick off a start, then the poller
    // sees it reach RUNNING.
    mocks.getWarehouseState.mockResolvedValue("STOPPED" as WarehouseState);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);

    await runPlugin();
    await flush();

    // A stopped warehouse is nudged to start before we wait on it.
    expect(mocks.startWarehouse).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntilRunning).toHaveBeenCalledTimes(1);
    // Because WE issued the start, the wait must poll through a stale post-start
    // STOPPED/STOPPING reading instead of bailing — assert the flag is set.
    expect(mocks.waitUntilRunning).toHaveBeenCalledWith(
      expect.anything(),
      "wh-test",
      expect.objectContaining({ treatStoppedAsTransient: true }),
    );
    // Call 1: initial buildStart generate. Call 2: the watch's regenerate once
    // the warehouse reached RUNNING.
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);
    // Foreground (dev) degrades instantly; the background watch regenerate must
    // DESCRIBE the now-RUNNING warehouse, so it runs blocking.
    expect(mocks.generateFromEntryPoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: "non-blocking" }),
    );
    expect(mocks.generateFromEntryPoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "blocking" }),
    );
  });

  test("STARTING → waits without starting, then RUNNING regenerates in dev", async () => {
    process.env.NODE_ENV = "development";
    // Warehouse is cold-starting, then warms up to RUNNING.
    mocks.getWarehouseState.mockResolvedValue("STARTING" as WarehouseState);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);

    await runPlugin();
    await flush();

    // Already coming up: no redundant start, just wait + regenerate.
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    // We didn't start it, so the wait keeps the default terminal states (a
    // STOPPED reading here would be a real stop, not a stale pre-start blip).
    expect(mocks.waitUntilRunning).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntilRunning).toHaveBeenCalledWith(
      expect.anything(),
      "wh-test",
      expect.objectContaining({ treatStoppedAsTransient: false }),
    );
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);
    // Foreground (dev) degrades instantly; the background watch regenerate runs
    // blocking so it describes the now-RUNNING warehouse.
    expect(mocks.generateFromEntryPoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: "non-blocking" }),
    );
    expect(mocks.generateFromEntryPoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "blocking" }),
    );
  });

  test("RUNNING → describes in the background after the dev foreground degrade", async () => {
    // Phase 3 regression fix: in dev the foreground only degrades, so a RUNNING
    // warehouse must still get REAL types from a background describe — it must
    // NOT be skipped just because it's already warm.
    process.env.NODE_ENV = "development";
    mocks.getWarehouseState.mockResolvedValue("RUNNING" as WarehouseState);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);

    await runPlugin();
    await flush();

    // Already RUNNING: no start. The wait is still issued (it returns on the
    // first poll for a running warehouse), and we didn't start it, so the
    // default terminal states apply.
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntilRunning).toHaveBeenCalledWith(
      expect.anything(),
      "wh-test",
      expect.objectContaining({ treatStoppedAsTransient: false }),
    );
    // Call 1: initial buildStart foreground (degraded). Call 2: the background
    // regenerate that DESCRIBEs the running warehouse and lands real types.
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);
    expect(mocks.generateFromEntryPoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: "non-blocking" }),
    );
    expect(mocks.generateFromEntryPoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "blocking" }),
    );
  });

  test("DELETED → leaves degraded types, no start/wait/regenerate, no crash", async () => {
    process.env.NODE_ENV = "development";
    // A deleted warehouse can't be started and blocking typegen would treat it
    // as fatal, so the watch must leave the foreground's degraded types in place.
    mocks.getWarehouseState.mockResolvedValue("DELETED" as WarehouseState);

    await expect(runPlugin()).resolves.toBeUndefined();
    await flush();

    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).not.toHaveBeenCalled();
    // Only the initial (degraded) foreground generate ran; nothing threw.
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);
  });

  test("DELETING → leaves degraded types, no start/wait/regenerate", async () => {
    process.env.NODE_ENV = "development";
    mocks.getWarehouseState.mockResolvedValue("DELETING" as WarehouseState);

    await runPlugin();
    await flush();

    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).not.toHaveBeenCalled();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);
  });

  test("background regenerate errors are swallowed (no crash), degraded remains", async () => {
    // Even when the warehouse is RUNNING and the blocking regenerate THROWS
    // (e.g. DESCRIBE surfaced a syntax/fatal error), nothing escapes into dev
    // startup: in dev generateOnce catches+logs the throw (and the detached
    // IIFE's catch is a further backstop), so the process never crashes and the
    // degraded types written by the foreground remain.
    process.env.NODE_ENV = "development";
    mocks.getWarehouseState.mockResolvedValue("RUNNING" as WarehouseState);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);
    // First call = foreground (degraded) succeeds; second = background blocking
    // describe rejects.
    mocks.generateFromEntryPoint
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("warehouse exploded"));

    await expect(runPlugin()).resolves.toBeUndefined();
    await flush();

    // The background regenerate was attempted (2 calls) but its rejection never
    // escaped into the caller.
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);
  });

  test("no watch in production (armWarehouseWatch no-ops)", async () => {
    process.env.NODE_ENV = "production";
    // Even if the warehouse were STOPPED, production must not arm the watch.
    mocks.getWarehouseState.mockResolvedValue("STOPPED" as WarehouseState);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);

    await runPlugin();
    await flush();

    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).not.toHaveBeenCalled();
    // Only the blocking initial build runs.
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);
  });

  test("aborts the armed watch when the dev server closes", async () => {
    process.env.NODE_ENV = "development";
    mocks.getWarehouseState.mockResolvedValue("STARTING" as WarehouseState);

    // Capture the signal handed to waitUntilRunning so we can assert the close
    // hook aborts it. Keep the wait pending until then.
    let capturedSignal: AbortSignal | undefined;
    const wait = deferred();
    mocks.waitUntilRunning.mockImplementation(
      (_client, _id, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts.signal;
        return wait.promise.then(() => "RUNNING" as WarehouseState);
      },
    );

    const plugin = makeConfiguredPlugin();
    const { server, httpServer } = makeFakeServer();
    getHook<ConfigureServerHook>(plugin, "configureServer")(server);
    const buildStart = getHook<BuildStartHook>(plugin, "buildStart");

    await buildStart();
    await flush();

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Dev server shutdown must abort the pending warehouse wait.
    httpServer.emit("close");
    expect(capturedSignal?.aborted).toBe(true);

    // Let the (now-aborted) wait settle; the IIFE swallows it and skips the
    // regenerate because the signal is aborted.
    wait.resolve();
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);
  });
});

describe("appKitTypesPlugin — per-save perf collapse (F2)", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedWarehouseId = process.env.DATABRICKS_WAREHOUSE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateFromEntryPoint.mockResolvedValue(undefined);
    mocks.startWarehouse.mockResolvedValue(undefined);
    process.env.NODE_ENV = "development";
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-test";
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;

    if (savedWarehouseId === undefined)
      delete process.env.DATABRICKS_WAREHOUSE_ID;
    else process.env.DATABRICKS_WAREHOUSE_ID = savedWarehouseId;
  });

  test("a single .sql save builds one WorkspaceClient and issues one warehouses.get", async () => {
    // RUNNING so the watch probes once, then immediately regenerates (its wait
    // returns on the first poll). We isolate a single save by letting the initial
    // build's watch fully settle first, then measuring the delta for one save.
    mocks.getWarehouseState.mockResolvedValue("RUNNING" as WarehouseState);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);

    const plugin = makeConfiguredPlugin();
    const { server, watcher } = makeFakeServer();
    getHook<ConfigureServerHook>(plugin, "configureServer")(server);
    const buildStart = getHook<BuildStartHook>(plugin, "buildStart");

    // Initial build arms + completes watch #1.
    await buildStart();
    await flush();

    // Measure only the single save below.
    mocks.workspaceClientCtor.mockClear();
    mocks.getWarehouseState.mockClear();

    watcher.emit(
      "change",
      path.join(process.cwd(), "config", "queries", "q.sql"),
    );
    await flush();

    // Exactly one client construction and one status RPC for the save — the
    // F2 acceptance criterion.
    expect(mocks.workspaceClientCtor).toHaveBeenCalledTimes(1);
    expect(mocks.getWarehouseState).toHaveBeenCalledTimes(1);
  });

  test("five rapid saves do not fan out — one waiter, one client, one get", async () => {
    // Hold the watch's wait pending so all five saves land while watch #1 is
    // still in flight. One-waiter re-arm must coalesce them onto that single
    // watch instead of spawning a client + probe per save.
    mocks.getWarehouseState.mockResolvedValue("STARTING" as WarehouseState);
    const wait = deferred();
    mocks.waitUntilRunning.mockReturnValue(
      wait.promise.then(() => "RUNNING" as WarehouseState),
    );

    const plugin = makeConfiguredPlugin();
    const { server, watcher } = makeFakeServer();
    getHook<ConfigureServerHook>(plugin, "configureServer")(server);
    const buildStart = getHook<BuildStartHook>(plugin, "buildStart");

    // buildStart arms watch #1 (now parked on the pending wait).
    await buildStart();
    await flush();
    expect(mocks.workspaceClientCtor).toHaveBeenCalledTimes(1);
    expect(mocks.getWarehouseState).toHaveBeenCalledTimes(1);

    // Five rapid .sql saves while watch #1 is still waiting.
    const sqlFile = path.join(process.cwd(), "config", "queries", "q.sql");
    for (let i = 0; i < 5; i++) watcher.emit("change", sqlFile);
    await flush();

    // No fan-out: still exactly one client + one status RPC despite six triggers.
    expect(mocks.workspaceClientCtor).toHaveBeenCalledTimes(1);
    expect(mocks.getWarehouseState).toHaveBeenCalledTimes(1);
    // And only one warehouse wait is in flight, not five.
    expect(mocks.waitUntilRunning).toHaveBeenCalledTimes(1);

    // Let the watch finish so the trailing regenerate fires and no timer leaks.
    wait.resolve();
    await flush();
  });

  test("after a watch settles, the next save arms a fresh watch (latch released)", async () => {
    // The one-waiter latch must release on completion, or saves after the first
    // watch would be permanently ignored.
    mocks.getWarehouseState.mockResolvedValue("RUNNING" as WarehouseState);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);

    const plugin = makeConfiguredPlugin();
    const { server, watcher } = makeFakeServer();
    getHook<ConfigureServerHook>(plugin, "configureServer")(server);
    const buildStart = getHook<BuildStartHook>(plugin, "buildStart");

    await buildStart();
    await flush();
    const ctorAfterBuild = mocks.workspaceClientCtor.mock.calls.length;

    // A save after the first watch settled must arm a new watch (one more client
    // + one more probe).
    watcher.emit(
      "change",
      path.join(process.cwd(), "config", "queries", "q.sql"),
    );
    await flush();

    expect(mocks.workspaceClientCtor.mock.calls.length).toBe(
      ctorAfterBuild + 1,
    );
  });

  test("a non-blocking save during a blocking warm-up does not downgrade the pending describe", async () => {
    // Sticky mode: while the background blocking regenerate is queued behind an
    // in-flight foreground run, a coalesced non-blocking .sql save must NOT
    // downgrade the trailing run to non-blocking — real (described) types still
    // land.
    //
    // We drive the real path: the buildStart foreground runs non-blocking and is
    // held in flight (deferred); the armed watch reaches RUNNING and enqueues a
    // blocking trailing run; then a non-blocking .sql save lands. The save's
    // re-armed watch sees DELETED (the 2nd getWarehouseState) so it does NOT
    // inject another blocking trigger — proving the blocking trailing run
    // survives purely because of sticky escalation, not a later re-escalation.
    mocks.getWarehouseState
      .mockResolvedValueOnce("RUNNING" as WarehouseState) // watch #1 → blocking regen
      .mockResolvedValue("DELETED" as WarehouseState); // watch #2 (save) → no-op
    mocks.waitUntilRunning.mockResolvedValue("RUNNING" as WarehouseState);

    const first = deferred();
    const trailing = deferred();
    mocks.generateFromEntryPoint
      .mockReturnValueOnce(first.promise) // initial foreground (in flight)
      .mockReturnValueOnce(trailing.promise); // the single trailing run

    const plugin = makeConfiguredPlugin();
    const { server, watcher } = makeFakeServer();
    getHook<ConfigureServerHook>(plugin, "configureServer")(server);
    const buildStart = getHook<BuildStartHook>(plugin, "buildStart");

    // Initial foreground non-blocking generate is now in flight (deferred), and
    // watch #1 (RUNNING) has enqueued a blocking trailing run behind it.
    await buildStart();
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);

    // A non-blocking .sql save lands while still in flight — must NOT downgrade
    // the queued blocking trailing run.
    watcher.emit(
      "change",
      path.join(process.cwd(), "config", "queries", "q.sql"),
    );
    await flush();
    // Still only the one in-flight run; nothing started concurrently.
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(1);

    // Release the in-flight run → the single trailing run fires, and it must be
    // blocking (escalated), not downgraded to non-blocking by the later save.
    first.resolve();
    await flush();
    expect(mocks.generateFromEntryPoint).toHaveBeenCalledTimes(2);
    expect(mocks.generateFromEntryPoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "blocking" }),
    );

    trailing.resolve();
    await flush();
  });
});

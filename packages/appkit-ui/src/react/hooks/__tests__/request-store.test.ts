import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRequestStore, type RequestControls } from "../request-store";

interface Snap {
  value: number | null;
}
const IDLE: Snap = { value: null };

// A store whose `run` just records how often it fired (no real transport), so
// these tests exercise the generic lifecycle in isolation from SSE/Arrow.
function makeStore() {
  const store = createRequestStore<Snap>(IDLE);
  const run = vi.fn((_c: RequestControls<Snap>) => {});
  return { store, run };
}

describe("createRequestStore", () => {
  let store: ReturnType<typeof makeStore>["store"];
  let run: ReturnType<typeof makeStore>["run"];

  beforeEach(() => {
    ({ store, run } = makeStore());
  });

  test("two retains on the same key start the request once", () => {
    const r1 = store.retain("k", run);
    const r2 = store.retain("k", run);
    expect(run).toHaveBeenCalledTimes(1);
    r1();
    r2();
  });

  test("distinct keys start separate requests", () => {
    store.retain("a", run);
    store.retain("b", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("re-retaining within a tick after release reuses the request", () => {
    const release = store.retain("k", run);
    release();
    store.retain("k", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("re-retaining after the deferred teardown starts a fresh request", async () => {
    const release = store.retain("k", run);
    release();
    // Let the deferred teardown run: the entry is dropped.
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.retain("k", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("patch fans the new snapshot out to every subscriber of a key", () => {
    const listener = vi.fn();
    store.subscribe("k", listener);
    store.retain("k", (c) => c.patch({ value: 42 }));

    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot("k").value).toBe(42);
  });

  test("getSnapshot returns the idle snapshot for a key with no entry", () => {
    expect(store.getSnapshot("missing")).toBe(IDLE);
  });

  test("autoStart:false defers the run until start() is called", () => {
    store.retain("k", run, false);
    expect(run).not.toHaveBeenCalled();

    store.start("k");
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("restartStarted re-runs started entries and leaves never-started ones idle", () => {
    const deferred = vi.fn((_c: RequestControls<Snap>) => {});
    store.retain("started", run);
    store.retain("deferred", deferred, false);

    store.restartStarted();

    expect(run).toHaveBeenCalledTimes(2);
    expect(deferred).not.toHaveBeenCalled();

    // Once started by hand, the deferred entry is restarted too.
    store.start("deferred");
    store.restartStarted();
    expect(deferred).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("restartStarted restarts only the keys the predicate accepts", () => {
    const other = vi.fn((_c: RequestControls<Snap>) => {});
    store.retain("notes /a", run);
    store.retain("boards /b", other);

    const seen: string[] = [];
    store.restartStarted((key) => {
      seen.push(key);
      return key.startsWith("notes ");
    });

    expect(seen.sort()).toEqual(["boards /b", "notes /a"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });

  test("restartStarted aborts the prior run before re-running with a fresh signal", () => {
    const signals: AbortSignal[] = [];
    store.retain("k", (c) => {
      signals.push(c.signal);
    });

    store.restartStarted();

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  test("restartStarted keeps the snapshot and notifies through the restarted run", () => {
    const listener = vi.fn();
    let runs = 0;
    store.subscribe("k", listener);
    store.retain("k", (c) => {
      runs += 1;
      if (runs === 1) c.patch({ value: 1 });
    });
    listener.mockClear();

    store.restartStarted();

    // The store keeps the last result; only the run decides what to patch.
    expect(store.getSnapshot("k").value).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    expect(runs).toBe(2);
  });

  test("reset aborts in-flight runs and clears entries", () => {
    let captured: AbortSignal | undefined;
    store.retain("k", (c) => {
      captured = c.signal;
    });
    expect(captured?.aborted).toBe(false);

    store.reset();

    expect(captured?.aborted).toBe(true);
    // Entry is gone: a fresh retain starts a new run.
    store.retain("k", run);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

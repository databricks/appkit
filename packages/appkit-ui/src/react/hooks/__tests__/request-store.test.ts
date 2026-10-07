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

function deferredRunner(onStart?: (controls: RequestControls<Snap>) => void) {
  const runs: {
    controls: RequestControls<Snap>;
    complete(value: number): void;
  }[] = [];
  const run = (controls: RequestControls<Snap>) =>
    new Promise<void>((resolve) => {
      runs.push({
        controls,
        complete(value) {
          if (!controls.signal.aborted) controls.patch({ value });
          resolve();
        },
      });
      if (controls.signal.aborted) resolve();
      else
        controls.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      onStart?.(controls);
    });
  return { run, runs };
}

const flushRuns = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
    store.retain("k", run, { autoStart: false });
    expect(run).not.toHaveBeenCalled();

    store.start("k");
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("restartStarted re-runs started entries and leaves never-started ones idle", () => {
    const deferred = vi.fn((_c: RequestControls<Snap>) => {});
    store.retain("started", run);
    store.retain("deferred", deferred, { autoStart: false });

    store.restartStarted();

    expect(run).toHaveBeenCalledTimes(2);
    expect(deferred).not.toHaveBeenCalled();

    // Once started by hand, the deferred entry is restarted too.
    store.start("deferred");
    store.restartStarted();
    expect(deferred).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("restartStarted restarts only the entries the predicate accepts, by key and meta", () => {
    const tagged = createRequestStore<Snap, { table: string }>(IDLE);
    const notes = vi.fn((_c: RequestControls<Snap>) => {});
    const boards = vi.fn((_c: RequestControls<Snap>) => {});
    tagged.retain("/a", notes, { meta: { table: "notes" } });
    tagged.retain("/b", boards, { meta: { table: "boards" } });
    // A later joiner shares the entry, so its meta is ignored.
    tagged.retain("/a", notes, { meta: { table: "boards" } });

    const seen: [string, string | undefined][] = [];
    void tagged.restartStarted((key, meta) => {
      seen.push([key, meta?.table]);
      return meta?.table === "notes";
    });

    expect(seen.sort()).toEqual([
      ["/a", "notes"],
      ["/b", "boards"],
    ]);
    expect(notes).toHaveBeenCalledTimes(2);
    expect(boards).toHaveBeenCalledTimes(1);
  });

  test("restartStarted skips an entry whose last subscriber left before teardown", async () => {
    const release = store.retain("gone", run);
    store.retain("kept", run);
    release();

    // Teardown is deferred a tick; the released entry must not run again.
    void store.restartStarted();
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.at(-1)?.[0].signal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    store.retain("gone", run);
    expect(run).toHaveBeenCalledTimes(4);
  });

  test("restartStarted resolves once every restarted run settles", async () => {
    const pending: (() => void)[] = [];
    store.retain(
      "k",
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    );
    store.retain("void", run);

    let settled = false;
    const restarted = store.restartStarted().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    pending[1]?.();
    await restarted;
    expect(settled).toBe(true);
  });

  test("overlapping restartStarted calls both wait for the current run", async () => {
    const pending = deferredRunner();
    store.retain("k", pending.run);
    pending.runs[0]?.complete(1);

    const settled: string[] = [];
    const first = store.restartStarted().then(() => {
      settled.push("first");
    });
    const second = store.restartStarted().then(() => {
      settled.push("second");
    });
    expect(pending.runs[1]?.controls.signal.aborted).toBe(true);
    await flushRuns();
    expect(settled).toEqual([]);
    expect(store.getSnapshot("k").value).toBe(1);

    pending.runs[2]?.complete(3);
    await Promise.all([first, second]);
    expect(settled.sort()).toEqual(["first", "second"]);
    expect(store.getSnapshot("k").value).toBe(3);
  });

  test("rechecks a key that settled before another restarted key was superseded", async () => {
    const a = deferredRunner();
    const b = deferredRunner();
    store.retain("a", a.run);
    store.retain("b", b.run);
    a.runs[0]?.complete(1);
    b.runs[0]?.complete(1);

    const settled: string[] = [];
    const first = store.restartStarted().then(() => {
      settled.push("first");
    });
    a.runs[1]?.complete(2);
    await flushRuns();
    expect(settled).toEqual([]);

    const second = store.restartStarted().then(() => {
      settled.push("second");
    });
    b.runs[2]?.complete(3);
    await flushRuns();
    expect(settled).toEqual([]);
    expect(store.getSnapshot("a").value).toBe(2);

    a.runs[2]?.complete(3);
    await Promise.all([first, second]);
    expect(settled.sort()).toEqual(["first", "second"]);
    expect(store.getSnapshot("a").value).toBe(3);
  });

  test("follows a manual start that supersedes a pending restart", async () => {
    const pending = deferredRunner();
    store.retain("k", pending.run);
    pending.runs[0]?.complete(1);
    let settled = false;
    const restarted = store.restartStarted().then(() => {
      settled = true;
    });
    store.start("k");
    await flushRuns();
    expect(settled).toBe(false);

    pending.runs[2]?.complete(3);
    await restarted;
    expect(store.getSnapshot("k").value).toBe(3);
  });

  test("waits for an original entry re-retained before the refresh barrier settles", async () => {
    const b = deferredRunner();
    let releaseB!: () => void;
    let replaceB = false;
    const a = deferredRunner(() => {
      if (!replaceB) return;
      replaceB = false;
      releaseB();
      queueMicrotask(() => {
        store.retain("b", b.run);
        store.start("b");
      });
    });
    store.retain("a", a.run);
    releaseB = store.retain("b", b.run);
    a.runs[0]?.complete(1);
    b.runs[0]?.complete(1);
    replaceB = true;

    let settled = false;
    const restarted = store.restartStarted().then(() => {
      settled = true;
    });
    a.runs[1]?.complete(2);
    await flushRuns();
    expect(b.runs).toHaveLength(2);
    expect(settled).toBe(false);

    b.runs[1]?.complete(2);
    await restarted;
    expect(store.getSnapshot("b").value).toBe(2);
  });

  test("does not follow a new entry that reuses a reset key", async () => {
    const pending = deferredRunner();
    store.retain("k", pending.run);
    pending.runs[0]?.complete(1);
    let settled = false;
    const restarted = store.restartStarted().then(() => {
      settled = true;
    });
    store.reset();

    const replacement = deferredRunner();
    store.retain("k", replacement.run);
    await flushRuns();
    expect(settled).toBe(true);
    await restarted;
    expect(pending.runs[1]?.controls.signal.aborted).toBe(true);
    expect(replacement.runs[0]?.controls.signal.aborted).toBe(false);
    expect(store.getSnapshot("k")).toBe(IDLE);
    store.reset();
  });

  test("waits for a run started synchronously by a snapshot subscriber", async () => {
    const pending = deferredRunner((controls) => controls.patch({ value: 1 }));
    store.retain("k", pending.run);
    pending.runs[0]?.complete(1);
    let replaced = false;
    store.subscribe("k", () => {
      if (replaced) return;
      replaced = true;
      store.start("k");
    });

    let settled = false;
    const restarted = store.restartStarted().then(() => {
      settled = true;
    });
    await flushRuns();
    expect(pending.runs[1]?.controls.signal.aborted).toBe(true);
    expect(settled).toBe(false);

    pending.runs[2]?.complete(3);
    await restarted;
    expect(store.getSnapshot("k").value).toBe(3);
  });

  test("restartStarted resolves even when a runner rejects", async () => {
    let runs = 0;
    store.retain("k", () => {
      runs += 1;
      return runs === 1 ? undefined : Promise.reject(new Error("broken"));
    });

    await expect(store.restartStarted()).resolves.toBeUndefined();
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

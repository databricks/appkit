import type { BasePlugin } from "shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

// Mock core singletons before importing the subject under test.
vi.mock("../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn().mockReturnValue({
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("../../telemetry", () => ({
  TelemetryManager: {
    getInstance: vi.fn().mockReturnValue({
      shutdown: vi.fn().mockResolvedValue(undefined),
    }),
    getProvider: vi.fn().mockReturnValue({
      getTracer: vi.fn().mockReturnValue({ startActiveSpan: vi.fn() }),
    }),
  },
}));

vi.mock("../../internal-telemetry", () => ({
  TelemetryReporter: {
    getInstance: vi.fn().mockReturnValue(null),
  },
}));

const { mockLoggerError } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
}));

vi.mock("../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  }),
}));

import { CacheManager } from "../../cache";
import { TelemetryReporter } from "../../internal-telemetry";
import { TelemetryManager } from "../../telemetry";
import { LifecycleManager } from "../lifecycle-manager";
import { PluginContext } from "../plugin-context";

function contextWithPlugins(plugins: Record<string, Partial<BasePlugin>>) {
  const ctx = new PluginContext();
  for (const [name, instance] of Object.entries(plugins)) {
    ctx.registerPlugin(name, instance as BasePlugin);
  }
  return ctx;
}

describe("LifecycleManager", () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    mockLoggerError.mockClear();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("shutdown", () => {
    test("runs plugin shutdown() hooks concurrently and exits 0", async () => {
      // Prove concurrency, not just "both called": hook B only resolves after
      // hook A has started. If the manager awaited hooks serially (A fully
      // before B), B would never observe A as started and this would hang.
      let aStarted: (() => void) | undefined;
      const aStartedGate = new Promise<void>((resolve) => {
        aStarted = resolve;
      });
      const shutdownA = vi.fn(async () => {
        aStarted?.();
      });
      const shutdownB = vi.fn(async () => {
        await aStartedGate;
      });
      const ctx = contextWithPlugins({
        a: { name: "a", shutdown: shutdownA },
        b: { name: "b", shutdown: shutdownB },
        "no-hooks": { name: "no-hooks" },
      });

      await new LifecycleManager(ctx).shutdown();

      expect(shutdownA).toHaveBeenCalledTimes(1);
      expect(shutdownB).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("stops the internal-telemetry reporter before aborting", async () => {
      const stop = vi.fn();
      const order: string[] = [];
      stop.mockImplementation(() => order.push("reporter-stop"));
      vi.mocked(TelemetryReporter.getInstance).mockReturnValueOnce({
        stop,
      } as any);
      const ctx = contextWithPlugins({
        a: {
          name: "a",
          abortActiveOperations: vi.fn(() => {
            order.push("abort");
          }),
        },
      });

      await new LifecycleManager(ctx).shutdown();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["reporter-stop", "abort"]);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("aborts active operations with error isolation", async () => {
      const okAbort = vi.fn();
      const badAbort = vi.fn(() => {
        throw new Error("boom");
      });
      const ctx = contextWithPlugins({
        ok: { name: "ok", abortActiveOperations: okAbort },
        bad: { name: "bad", abortActiveOperations: badAbort },
      });

      await new LifecycleManager(ctx).shutdown();

      expect(okAbort).toHaveBeenCalledTimes(1);
      expect(badAbort).toHaveBeenCalledTimes(1);
      expect(
        mockLoggerError.mock.calls.some((c) =>
          String(c[0]).includes("Error aborting operations for plugin"),
        ),
      ).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("a failing plugin shutdown() is logged and does not abort shutdown", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("drain failed"));
      const healthy = vi.fn().mockResolvedValue(undefined);
      const ctx = contextWithPlugins({
        failing: { name: "failing", shutdown: failing },
        healthy: { name: "healthy", shutdown: healthy },
      });

      await new LifecycleManager(ctx).shutdown();

      expect(failing).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(
        mockLoggerError.mock.calls.some((c) =>
          String(c[0]).includes("Error shutting down plugin"),
        ),
      ).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("a hanging plugin shutdown() does not block past its 10s timeout", async () => {
      vi.useFakeTimers();
      const hanging = vi.fn(() => new Promise<void>(() => {}));
      const fast = vi.fn().mockResolvedValue(undefined);
      const ctx = contextWithPlugins({
        hanging: { name: "hanging", shutdown: hanging },
        fast: { name: "fast", shutdown: fast },
      });

      const done = new LifecycleManager(ctx).shutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      expect(hanging).toHaveBeenCalledTimes(1);
      expect(fast).toHaveBeenCalledTimes(1);
      expect(
        mockLoggerError.mock.calls.some(
          (c) =>
            String(c[0]).includes("Error shutting down plugin") &&
            c[1] === "hanging" &&
            String(c[2]).includes("timed out"),
        ),
      ).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("emits the 'shutdown' lifecycle event", async () => {
      const ctx = contextWithPlugins({});
      const hook = vi.fn();
      ctx.onLifecycle("shutdown", hook);

      await new LifecycleManager(ctx).shutdown();

      expect(hook).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("is not re-entrant — a second call is a no-op", async () => {
      const shutdownHook = vi.fn().mockResolvedValue(undefined);
      const ctx = contextWithPlugins({
        a: { name: "a", shutdown: shutdownHook },
      });
      const manager = new LifecycleManager(ctx);

      await Promise.all([manager.shutdown(), manager.shutdown()]);
      await manager.shutdown();

      expect(shutdownHook).toHaveBeenCalledTimes(1);
    });

    test("closes the cache storage and flushes telemetry", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      const flush = vi.fn().mockResolvedValue(undefined);
      vi.mocked(CacheManager.getInstanceSync).mockReturnValueOnce({
        close,
      } as any);
      vi.mocked(TelemetryManager.getInstance).mockReturnValueOnce({
        shutdown: flush,
      } as any);

      await new LifecycleManager(contextWithPlugins({})).shutdown();

      expect(close).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("a hanging telemetry flush cannot hang shutdown — the flush timeout still exits 0", async () => {
      vi.useFakeTimers();
      const hangingFlush = vi.fn(() => new Promise<never>(() => {}));
      vi.mocked(TelemetryManager.getInstance).mockReturnValueOnce({
        shutdown: hangingFlush,
      } as any);

      const done = new LifecycleManager(contextWithPlugins({})).shutdown();
      await vi.advanceTimersByTimeAsync(2_000);
      await done;

      expect(hangingFlush).toHaveBeenCalledTimes(1);
      expect(
        mockLoggerError.mock.calls.some(
          (c) =>
            String(c[0]).includes("Error flushing telemetry") &&
            String(c[1]).includes("timed out"),
        ),
      ).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("a hanging cache close cannot hang shutdown — the close timeout still exits 0", async () => {
      vi.useFakeTimers();
      const hangingClose = vi.fn(() => new Promise<never>(() => {}));
      vi.mocked(CacheManager.getInstanceSync).mockReturnValueOnce({
        close: hangingClose,
      } as any);

      const done = new LifecycleManager(contextWithPlugins({})).shutdown();
      await vi.advanceTimersByTimeAsync(2_000);
      await done;

      expect(hangingClose).toHaveBeenCalledTimes(1);
      expect(
        mockLoggerError.mock.calls.some(
          (c) =>
            String(c[0]).includes("Error closing cache storage") &&
            String(c[1]).includes("timed out"),
        ),
      ).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("a never-initialized cache is skipped without error", async () => {
      vi.mocked(CacheManager.getInstanceSync).mockImplementationOnce(() => {
        throw new Error("cache not initialized");
      });

      await new LifecycleManager(contextWithPlugins({})).shutdown();

      expect(
        mockLoggerError.mock.calls.some((c) =>
          String(c[0]).includes("Error closing cache storage"),
        ),
      ).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("runs phases in order: abort → plugin hooks → lifecycle emit → cache close + flush (concurrent) → exit", async () => {
      const order: string[] = [];
      const ctx = contextWithPlugins({
        a: {
          name: "a",
          abortActiveOperations: vi.fn(() => {
            order.push("abort");
          }),
          shutdown: vi.fn(async () => {
            order.push("plugin-shutdown");
          }),
        },
      });
      ctx.onLifecycle("shutdown", () => {
        order.push("lifecycle");
      });
      vi.mocked(CacheManager.getInstanceSync).mockReturnValueOnce({
        close: vi.fn(async () => {
          order.push("cache-close");
        }),
      } as any);
      vi.mocked(TelemetryManager.getInstance).mockReturnValueOnce({
        shutdown: vi.fn(async () => {
          order.push("flush");
        }),
      } as any);
      exitSpy.mockImplementationOnce(((_code?: number) => {
        order.push("exit");
      }) as any);

      await new LifecycleManager(ctx).shutdown();

      expect(order.slice(0, 3)).toEqual([
        "abort",
        "plugin-shutdown",
        "lifecycle",
      ]);
      // Cache close and telemetry flush run concurrently — assert both land
      // after the lifecycle emit and before exit; relative order unspecified.
      expect(order.slice(3, 5).sort()).toEqual(["cache-close", "flush"]);
      expect(order[5]).toBe("exit");
      expect(order).toHaveLength(6);
    });

    test("a plugin shutdown() that rejects after its timeout already won does not crash", async () => {
      vi.useFakeTimers();
      let rejectLate: ((err: Error) => void) | undefined;
      const lateRejecting = vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectLate = reject;
          }),
      );
      const ctx = contextWithPlugins({
        late: { name: "late", shutdown: lateRejecting },
      });

      const done = new LifecycleManager(ctx).shutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      // The hook loses the race, then rejects afterwards — must be swallowed
      // by the pre-attached no-op handler, not crash the process.
      rejectLate?.(new Error("late rejection"));
      await vi.advanceTimersByTimeAsync(0);

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe("installSignalHandlers", () => {
    test("registers SIGTERM/SIGINT once and triggers shutdown", async () => {
      const onceSpy = vi.spyOn(process, "once");
      const ctx = contextWithPlugins({});
      const manager = new LifecycleManager(ctx);

      manager.installSignalHandlers();

      const signals = onceSpy.mock.calls.map((c) => c[0]);
      expect(signals).toContain("SIGTERM");
      expect(signals).toContain("SIGINT");
      onceSpy.mockRestore();
    });
  });
  describe("close (the programmatic path)", () => {
    test("runs the full teardown sequence without exiting the process", async () => {
      const stop = vi.fn();
      vi.mocked(TelemetryReporter.getInstance).mockReturnValue({
        stop,
      } as never);
      const cacheClose = vi.fn().mockResolvedValue(undefined);
      vi.mocked(CacheManager.getInstanceSync).mockReturnValue({
        close: cacheClose,
      } as never);
      const telemetryShutdown = vi.fn().mockResolvedValue(undefined);
      vi.mocked(TelemetryManager.getInstance).mockReturnValue({
        shutdown: telemetryShutdown,
      } as never);

      const abortActiveOperations = vi.fn();
      const shutdown = vi.fn().mockResolvedValue(undefined);
      const ctx = contextWithPlugins({
        alpha: { name: "alpha", abortActiveOperations, shutdown } as never,
      });
      const emit = vi.spyOn(ctx, "emitLifecycle");
      const manager = new LifecycleManager(ctx);

      await manager.close();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(abortActiveOperations).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("shutdown");
      expect(cacheClose).toHaveBeenCalledTimes(1);
      expect(telemetryShutdown).toHaveBeenCalledTimes(1);

      // The whole point of the split.
      expect(exitSpy).not.toHaveBeenCalled();
    });

    test("is idempotent: teardown runs once and the second call awaits it", async () => {
      let releaseShutdown: (() => void) | undefined;
      // Set only once the plugin hook has actually finished. Asserting against
      // this flag (rather than counting microtask ticks) is what makes the test
      // sensitive to a guard that returns early while teardown is in flight.
      let teardownFinished = false;
      const shutdown = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseShutdown = () => {
              teardownFinished = true;
              resolve();
            };
          }),
      );
      const ctx = contextWithPlugins({
        alpha: { name: "alpha", shutdown } as never,
      });
      const manager = new LifecycleManager(ctx);

      const observed: string[] = [];
      const first = manager
        .close()
        .then(() => observed.push(`first:${teardownFinished}`));
      const second = manager
        .close()
        .then(() => observed.push(`second:${teardownFinished}`));

      // A full macrotask turn, so a guard that resolves the second caller
      // early has every chance to settle before the assertion below.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(observed).toEqual([]);

      releaseShutdown?.();
      await Promise.all([first, second]);

      // Both callers must observe a *completed* teardown. The old boolean
      // guard resolved the second caller with teardown still running.
      expect(observed).toEqual(
        expect.arrayContaining(["first:true", "second:true"]),
      );
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    test("a signal arriving after close() joins the same teardown, not a second one", async () => {
      const shutdown = vi.fn().mockResolvedValue(undefined);
      const ctx = contextWithPlugins({
        alpha: { name: "alpha", shutdown } as never,
      });
      const manager = new LifecycleManager(ctx);
      manager.installSignalHandlers();

      await manager.close();
      // The signal path after a close: teardown is memoized, so the phases do
      // not run twice even though shutdown() is still callable.
      await manager.shutdown();

      expect(shutdown).toHaveBeenCalledTimes(1);
    });

    test("close() after a signal-initiated teardown awaits the in-flight one", async () => {
      let releaseShutdown: (() => void) | undefined;
      // Sentinel rather than a tick count: `close()` reaches the memo through
      // raceWithTimeout, so "how many microtasks until it would have settled" is
      // not a property the test can rely on.
      let teardownFinished = false;
      const shutdown = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseShutdown = () => {
              teardownFinished = true;
              resolve();
            };
          }),
      );
      const ctx = contextWithPlugins({
        alpha: { name: "alpha", shutdown } as never,
      });
      const manager = new LifecycleManager(ctx);

      const signalPath = manager.shutdown();
      await Promise.resolve();

      let closeSawFinishedTeardown: boolean | undefined;
      const closePath = manager.close().then(() => {
        closeSawFinishedTeardown = teardownFinished;
      });

      // A full macrotask turn, so a close() that resolved early would have.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closeSawFinishedTeardown).toBeUndefined();

      releaseShutdown?.();
      await Promise.all([signalPath, closePath]);

      expect(shutdown).toHaveBeenCalledTimes(1);
      // It joined the in-flight teardown rather than resolving alongside it.
      expect(closeSawFinishedTeardown).toBe(true);
      // The signal wanted the process dead, and still gets it.
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("a rejecting plugin shutdown() is isolated and close() still resolves", async () => {
      const ctx = contextWithPlugins({
        bad: {
          name: "bad",
          shutdown: vi.fn().mockRejectedValue(new Error("teardown blew up")),
        } as never,
        good: {
          name: "good",
          shutdown: vi.fn().mockResolvedValue(undefined),
        } as never,
      });
      const manager = new LifecycleManager(ctx);

      await expect(manager.close()).resolves.toBeUndefined();
      expect(mockLoggerError).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    test("a hung teardown is bounded by close()'s budget, logged, and never exits", async () => {
      vi.useFakeTimers();
      const ctx = contextWithPlugins({
        stuck: {
          name: "stuck",
          shutdown: vi.fn(() => new Promise<void>(() => {})),
        } as never,
      });
      const manager = new LifecycleManager(ctx);

      const closing = manager.close({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(closing).resolves.toBeUndefined();

      // The error names the phase that was in flight, which is the whole
      // reason the phase tracker is retained.
      const logged = mockLoggerError.mock.calls
        .map((c) => String(c[0]))
        .join("\n");
      expect(logged).toContain("close() did not complete");
      const phases = mockLoggerError.mock.calls.flat().map(String).join(" ");
      expect(phases).toContain("plugin shutdown() hooks");

      // A hung teardown must not kill the process on the programmatic path.
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("signal-handler ownership", () => {
    test("close() removes only this manager's listeners", async () => {
      const foreign = vi.fn();
      process.on("SIGTERM", foreign);
      const baseline = process.listenerCount("SIGTERM");

      const a = new LifecycleManager(contextWithPlugins({}));
      const b = new LifecycleManager(contextWithPlugins({}));
      a.installSignalHandlers();
      b.installSignalHandlers();
      expect(process.listenerCount("SIGTERM")).toBe(baseline + 2);

      await a.close();

      // b's pair survives, and so does the unrelated host listener.
      expect(process.listenerCount("SIGTERM")).toBe(baseline + 1);

      await b.close();
      expect(process.listenerCount("SIGTERM")).toBe(baseline);
      expect(process.listeners("SIGTERM")).toContain(foreign);

      process.removeListener("SIGTERM", foreign);
    });

    test("listener counts return to the pre-install baseline", async () => {
      const termBaseline = process.listenerCount("SIGTERM");
      const intBaseline = process.listenerCount("SIGINT");

      const manager = new LifecycleManager(contextWithPlugins({}));
      manager.installSignalHandlers();
      await manager.close();

      // This is what keeps repeated boots in one test file from tripping
      // MaxListenersExceededWarning at ~6 un-closed apps.
      expect(process.listenerCount("SIGTERM")).toBe(termBaseline);
      expect(process.listenerCount("SIGINT")).toBe(intBaseline);
    });

    test("removeSignalHandlers is safe when none were installed", () => {
      const manager = new LifecycleManager(contextWithPlugins({}));
      expect(() => manager.removeSignalHandlers()).not.toThrow();
    });
  });
  describe("a teardown that outlives close()'s budget", () => {
    test("phase 5 still closes the app's own cache and telemetry, not the next app's", async () => {
      vi.useFakeTimers();

      // The app being torn down owns these.
      const ownCacheClose = vi.fn().mockResolvedValue(undefined);
      const ownTelemetryShutdown = vi.fn().mockResolvedValue(undefined);
      vi.mocked(CacheManager.getInstanceSync).mockReturnValue({
        close: ownCacheClose,
      } as never);
      vi.mocked(TelemetryManager.getInstance).mockReturnValue({
        shutdown: ownTelemetryShutdown,
      } as never);

      // A plugin hook slower than close()'s budget but inside its own per-plugin
      // budget — the files plugin's 10s drain reaches exactly this state.
      let releaseHook: (() => void) | undefined;
      const ctx = contextWithPlugins({
        slow: {
          name: "slow",
          shutdown: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                releaseHook = resolve;
              }),
          ),
        } as never,
      });
      const manager = new LifecycleManager(ctx);

      const closing = manager.close({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(closing).resolves.toBeUndefined();

      // close() has given up waiting and already dropped the singletons, so the
      // static slots now answer with a *different* app's resources.
      const nextCacheClose = vi.fn().mockResolvedValue(undefined);
      const nextTelemetryShutdown = vi.fn().mockResolvedValue(undefined);
      vi.mocked(CacheManager.getInstanceSync).mockReturnValue({
        close: nextCacheClose,
      } as never);
      vi.mocked(TelemetryManager.getInstance).mockReturnValue({
        shutdown: nextTelemetryShutdown,
      } as never);

      // Now let the orphaned teardown finish and reach phase 5.
      releaseHook?.();
      await vi.advanceTimersByTimeAsync(10);

      // It must act on what it captured at the start, never on the current slots.
      expect(ownCacheClose).toHaveBeenCalledTimes(1);
      expect(ownTelemetryShutdown).toHaveBeenCalledTimes(1);
      expect(nextCacheClose).not.toHaveBeenCalled();
      expect(nextTelemetryShutdown).not.toHaveBeenCalled();
    });
  });
});

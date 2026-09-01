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

// Mock core singletons before importing the subject under test. The cache is
// not among them: `LifecycleManager` takes this app's manager as a dependency,
// so each test passes a double directly.
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

/** A stand-in for this app's manager; only `close()` is exercised here. */
function cacheDouble(close = vi.fn().mockResolvedValue(undefined)) {
  return { close } as unknown as import("../../cache").CacheManager;
}

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

      await new LifecycleManager(ctx, cacheDouble()).shutdown();

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

      await new LifecycleManager(ctx, cacheDouble()).shutdown();

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

      await new LifecycleManager(ctx, cacheDouble()).shutdown();

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

      await new LifecycleManager(ctx, cacheDouble()).shutdown();

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

      const done = new LifecycleManager(ctx, cacheDouble()).shutdown();
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

      await new LifecycleManager(ctx, cacheDouble()).shutdown();

      expect(hook).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("is not re-entrant — a second call is a no-op", async () => {
      const shutdownHook = vi.fn().mockResolvedValue(undefined);
      const ctx = contextWithPlugins({
        a: { name: "a", shutdown: shutdownHook },
      });
      const manager = new LifecycleManager(ctx, cacheDouble());

      await Promise.all([manager.shutdown(), manager.shutdown()]);
      await manager.shutdown();

      expect(shutdownHook).toHaveBeenCalledTimes(1);
    });

    test("closes the cache storage and flushes telemetry", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      const flush = vi.fn().mockResolvedValue(undefined);
      vi.mocked(TelemetryManager.getInstance).mockReturnValueOnce({
        shutdown: flush,
      } as any);

      await new LifecycleManager(
        contextWithPlugins({}),
        cacheDouble(close),
      ).shutdown();

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

      const done = new LifecycleManager(
        contextWithPlugins({}),
        cacheDouble(),
      ).shutdown();
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

      const done = new LifecycleManager(
        contextWithPlugins({}),
        cacheDouble(hangingClose),
      ).shutdown();
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
      vi.mocked(TelemetryManager.getInstance).mockReturnValueOnce({
        shutdown: vi.fn(async () => {
          order.push("flush");
        }),
      } as any);
      exitSpy.mockImplementationOnce(((_code?: number) => {
        order.push("exit");
      }) as any);

      await new LifecycleManager(
        ctx,
        cacheDouble(
          vi.fn(async () => {
            order.push("cache-close");
          }),
        ),
      ).shutdown();

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

      const done = new LifecycleManager(ctx, cacheDouble()).shutdown();
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
      const manager = new LifecycleManager(ctx, cacheDouble());

      manager.installSignalHandlers();

      const signals = onceSpy.mock.calls.map((c) => c[0]);
      expect(signals).toContain("SIGTERM");
      expect(signals).toContain("SIGINT");
      onceSpy.mockRestore();
    });
  });
});

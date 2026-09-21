import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { usePoll } from "../use-poll";

/**
 * Test suite for usePoll using fake timers.
 * Focus on core behaviors: backoff, in-flight guard, controls, telemetry.
 */
describe("usePoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe("immediate-first + interval ticking", () => {
    test("fires once at t=0 when immediate=true (default)", async () => {
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => usePoll(runOnce));

      // Should fire at mount (immediate). Flush the async first tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);

      // Advance to interval (1000ms).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Next call should have fired.
      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(result.current.attempts).toBe(2);
    }, 15000);

    test("does not fire at t=0 when immediate=false", async () => {
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { result } = renderHook(() =>
        usePoll(runOnce, { immediate: false }),
      );

      // Should not fire at mount.
      expect(runOnce).not.toHaveBeenCalled();
      expect(result.current.paused).toBe(true);

      // Resume to start the scheduler (immediate=false starts paused).
      await act(async () => {
        result.current.resume();
        await vi.advanceTimersByTimeAsync(0);
      });

      // After resuming, it fires immediately, then continues on the cadence.
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.attempts).toBe(1);

      // Advance to next interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(result.current.attempts).toBe(2);
    }, 15000);

    test("respects custom intervalMs", async () => {
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { result } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 300 }),
      );

      // Immediate. Flush the async first tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);

      // First interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(result.current.attempts).toBe(2);
    }, 15000);
  });

  describe("in-flight guard", () => {
    test("skips a tick that arrives while runOnce is pending", async () => {
      let resolveFn: (() => void) | undefined;
      const runOnce = vi.fn(
        (): Promise<void> =>
          new Promise((resolve) => {
            resolveFn = resolve;
          }),
      );

      const { result } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 100 }),
      );

      // Immediate call starts. Flush async tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.attempts).toBe(0);

      // Advance to second tick; the first is still pending.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // runOnce was not called again (skipped).
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.skipped).toBe(1);

      // Third tick; still pending.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.skipped).toBe(2);

      // Resolve the first call.
      await act(async () => {
        if (resolveFn) {
          resolveFn();
        }
      });

      expect(result.current.attempts).toBe(1);

      // Next tick fires normally.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(result.current.skipped).toBe(2);
    }, 15000);
  });

  describe("exponential backoff", () => {
    test("backs off on error, resumes on deadline", async () => {
      let errorCount = 0;
      const runOnce = vi.fn(async () => {
        if (errorCount < 1) {
          errorCount += 1;
          throw new Error("fail");
        }
      });

      const { result } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 300, immediate: true }),
      );

      // t=0: immediate attempt (fails, backoff=1s). Flush async tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.errors).toBe(1);
      expect(result.current.consecutiveErrors).toBe(1);

      // t=300: base interval tick, but still in backoff. Skip.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.skipped).toBe(1);

      // t=600: second interval tick, still in backoff. Skip.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.skipped).toBe(2);

      // t=900: third interval tick, still in backoff. Skip.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.skipped).toBe(3);

      // t=1200: fourth interval tick, backoff deadline has passed. Retry (succeeds).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(result.current.attempts).toBe(2);
      expect(result.current.consecutiveErrors).toBe(0);
    }, 15000);

    test("consecutive errors with maxConsecutiveErrors", async () => {
      const runOnce = vi.fn(async () => {
        throw new Error("always fail");
      });

      const { result } = renderHook(() =>
        usePoll(runOnce, {
          intervalMs: 100,
          immediate: true,
          maxConsecutiveErrors: 2,
        }),
      );

      // Flush the first error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.consecutiveErrors).toBe(1);

      // Advance for second error (backoff=1s).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(result.current.consecutiveErrors).toBe(2);
      expect(result.current.paused).toBe(true);
    }, 15000);
  });

  describe("controls: pause, resume, restart", () => {
    test("pause() stops ticking", async () => {
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { result } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 300, immediate: true }),
      );

      // Flush the immediate tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.attempts).toBe(1);

      // Pause.
      await act(async () => {
        result.current.pause();
      });
      expect(result.current.paused).toBe(true);

      // Advance past a normal tick; nothing should happen.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
    }, 10000);

    test("resume() polls immediately then resumes cadence", async () => {
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { result } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 300, immediate: false }),
      );

      expect(result.current.paused).toBe(true);

      // Resume. This calls executeRun() immediately and starts ticking.
      await act(async () => {
        result.current.resume();
        // Flush the async resume call.
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.paused).toBe(false);

      expect(runOnce).toHaveBeenCalledTimes(1);

      // Advance to next interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(runOnce).toHaveBeenCalledTimes(2);
    }, 15000);

    test("restart() clears telemetry", async () => {
      let errorCount = 0;
      const runOnce = vi.fn(async () => {
        if (errorCount < 1) {
          errorCount += 1;
          throw new Error("fail");
        }
      });

      const { result } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 300, immediate: true }),
      );

      // Flush the first error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.errors).toBe(1);

      // Pause first.
      await act(async () => {
        result.current.pause();
      });

      // Restart.
      await act(async () => {
        result.current.restart();
      });

      expect(result.current.paused).toBe(true);
      expect(result.current.attempts).toBe(0);
      expect(result.current.errors).toBe(0);
      expect(result.current.consecutiveErrors).toBe(0);
    }, 10000);
  });

  describe("refetch()", () => {
    test("triggers out-of-band run", async () => {
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { result } = renderHook(() =>
        usePoll(runOnce, { immediate: false }),
      );

      expect(runOnce).not.toHaveBeenCalled();

      // Refetch out-of-band.
      await act(async () => {
        result.current.refetch();
        // Flush the async refetch call.
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.attempts).toBe(1);
    }, 10000);

    test("skips if a run is in-flight", async () => {
      let resolveFn: (() => void) | undefined;
      const runOnce = vi.fn(
        (): Promise<void> =>
          new Promise((resolve) => {
            resolveFn = resolve;
          }),
      );

      const { result } = renderHook(() =>
        usePoll(runOnce, { immediate: false }),
      );

      // Start a manual run.
      await act(async () => {
        result.current.refetch();
        // Flush the async refetch call.
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);

      // Try refetch while in-flight.
      await act(async () => {
        result.current.refetch();
      });
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(result.current.skipped).toBe(1);

      // Resolve.
      await act(async () => {
        if (resolveFn) {
          resolveFn();
        }
      });

      expect(result.current.attempts).toBe(1);
    }, 10000);
  });

  describe("latency telemetry", () => {
    test("captures lastLatencyMs and computes p50", async () => {
      const runOnce = vi
        .fn()
        .mockImplementationOnce(
          (): Promise<void> =>
            new Promise((resolve) => {
              setTimeout(resolve, 50);
            }),
        )
        .mockImplementationOnce(
          (): Promise<void> =>
            new Promise((resolve) => {
              setTimeout(resolve, 100);
            }),
        );

      const { result } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 300, immediate: true }),
      );

      // t=0: immediate (takes 50ms). Advance time to allow the setTimeout to fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(result.current.lastLatencyMs).toBeGreaterThan(0);

      // t=300: next tick (takes 100ms).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      // Advance time for the 100ms setTimeout to fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Both latencies should be recorded.
      expect(result.current.attempts).toBe(2);
      expect(result.current.latency.p50).toBeGreaterThan(0);
    }, 15000);
  });

  describe("cleanup", () => {
    test("unmount clears the timer", async () => {
      const runOnce = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { unmount } = renderHook(() =>
        usePoll(runOnce, { intervalMs: 300, immediate: true }),
      );

      // Flush the immediate tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(runOnce).toHaveBeenCalledTimes(1);

      unmount();

      // Advance past a normal tick; nothing should happen.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(runOnce).toHaveBeenCalledTimes(1);
    }, 10000);
  });
});

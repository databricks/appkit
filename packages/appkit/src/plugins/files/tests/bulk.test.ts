import { describe, expect, test, vi } from "vitest";
import {
  createConcurrencyLimiter,
  resolveConcurrency,
  retryWithBackoff,
} from "../bulk";

describe("createConcurrencyLimiter", () => {
  test("executes tasks up to the concurrency limit", async () => {
    const limit = createConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return maxActive;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBe(2);
  });

  test("runs tasks in FIFO order when queued", async () => {
    const limit = createConcurrencyLimiter(1);
    const order: number[] = [];

    const task = (id: number) =>
      limit(async () => {
        order.push(id);
      });

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("returns the value from the wrapped function", async () => {
    const limit = createConcurrencyLimiter(2);
    const result = await limit(async () => 42);
    expect(result).toBe(42);
  });

  test("propagates errors from the wrapped function", async () => {
    const limit = createConcurrencyLimiter(2);
    await expect(
      limit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("releases slot on error so other tasks can proceed", async () => {
    const limit = createConcurrencyLimiter(1);

    const failing = limit(async () => {
      throw new Error("fail");
    }).catch(() => "failed");

    const succeeding = limit(async () => "ok");

    const results = await Promise.all([failing, succeeding]);
    expect(results).toContain("failed");
    expect(results).toContain("ok");
  });

  test("handles concurrency of 1 (sequential execution)", async () => {
    const limit = createConcurrencyLimiter(1);
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 5 }, () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    );

    await Promise.all(tasks);
    expect(maxActive).toBe(1);
  });
});

describe("retryWithBackoff", () => {
  test("returns immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { attempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on failure and succeeds on subsequent attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, {
      attempts: 3,
      initialDelay: 1,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("throws after all attempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(
      retryWithBackoff(fn, { attempts: 3, initialDelay: 1 }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("uses exponential backoff delays", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockResolvedValue("ok");

    vi.useFakeTimers();
    const promise = retryWithBackoff(fn, { attempts: 3, initialDelay: 100 });

    // First retry delay: 100ms (100 * 2^0)
    await vi.advanceTimersByTimeAsync(100);
    // Second retry delay: 200ms (100 * 2^1)
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe("ok");
    vi.useRealTimers();
  });

  test("defaults to 3 attempts and 1000ms initial delay", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    vi.useFakeTimers();
    const promise = retryWithBackoff(fn).catch(() => {});

    // Default: 3 attempts, delays of 1000ms and 2000ms
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  test("wraps non-Error throwables", async () => {
    const fn = vi.fn().mockRejectedValue("string error");
    await expect(retryWithBackoff(fn, { attempts: 1 })).rejects.toThrow(
      "string error",
    );
  });
});

describe("resolveConcurrency", () => {
  test("returns per-call override when provided", () => {
    expect(resolveConcurrency(4, { concurrency: 16 })).toBe(16);
  });

  test("returns volume config when no per-call override", () => {
    expect(resolveConcurrency(4)).toBe(4);
  });

  test("returns default when neither is provided", () => {
    expect(resolveConcurrency(undefined)).toBe(8);
  });

  test("per-call override takes precedence over volume config", () => {
    expect(resolveConcurrency(4, { concurrency: 2 })).toBe(2);
  });
});

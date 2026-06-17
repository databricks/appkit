import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_RETRY_SCHEDULE, withRetries } from "../retry";

describe("withRetries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns the result on first success without retrying", async () => {
    const fn = vi.fn(async () => "ok");
    const wrapped = withRetries(fn, [50, 500]);

    await expect(wrapped()).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries after each delay then succeeds", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("ok");
    const onLog = vi.fn();
    const wrapped = withRetries(fn, [50, 500], onLog);

    const promise = wrapped();
    // Run all pending timers (the inter-attempt delays) to completion.
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Retrying"),
      50,
      expect.stringContaining("fail 1"),
    );
  });

  test("throws the final error after exhausting the schedule", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });
    const wrapped = withRetries(fn, [10, 20]);

    const promise = wrapped();
    const assertion = expect(promise).rejects.toThrow("always fails");
    await vi.runAllTimersAsync();
    await assertion;

    // 2 retries (one per delay) + 1 final attempt
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("makes a single attempt when schedule is empty", async () => {
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    const wrapped = withRetries(fn, []);

    await expect(wrapped()).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("exposes a sensible default schedule", () => {
    expect(DEFAULT_RETRY_SCHEDULE).toEqual([50, 500, 5000]);
  });
});

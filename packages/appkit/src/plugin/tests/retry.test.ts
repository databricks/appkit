import type { RetryConfig } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RetryInterceptor } from "../interceptors/retry";
import type { InterceptorContext } from "../interceptors/types";

describe("RetryInterceptor", () => {
  let context: InterceptorContext;

  beforeEach(() => {
    context = {
      metadata: new Map(),
      userKey: "test",
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("should execute function once if it succeeds", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 3,
    };
    const interceptor = new RetryInterceptor(config);
    const fn = vi.fn().mockResolvedValue("success");

    const result = await interceptor.intercept(fn, context);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("should retry on failure up to max attempts", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 3,
      initialDelay: 1000,
    };
    const interceptor = new RetryInterceptor(config);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("success");

    const promise = interceptor.intercept(fn, context);

    // Fast-forward through delays
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("should throw error after exhausting all retries", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 3,
      initialDelay: 1000,
    };
    const interceptor = new RetryInterceptor(config);
    const error = new Error("persistent failure");
    const fn = vi.fn().mockRejectedValue(error);

    const promise = interceptor.intercept(fn, context);

    // Fast-forward through all retries and await rejection simultaneously
    const [_result] = await Promise.all([
      expect(promise).rejects.toThrow("persistent failure"),
      vi.runAllTimersAsync(),
    ]);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("should use exponential backoff", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 4,
      initialDelay: 1000,
    };

    vi.spyOn(Math, "random").mockReturnValue(1);
    const interceptor = new RetryInterceptor(config);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValueOnce(new Error("fail 3"))
      .mockResolvedValue("success");

    interceptor.intercept(fn, context);

    // With Math.random() = 1, jitter multiplier is 1x (no reduction)
    // First retry: 1000ms delay (2^0 * 1000 * 1)
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second retry: 2000ms delay (2^1 * 1000 * 1)
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    // Third retry: 4000ms delay (2^2 * 1000 * 1)
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(4);

    vi.spyOn(Math, "random").mockRestore();
  });

  test("should respect maxDelay cap", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 10,
      initialDelay: 1000,
      maxDelay: 5000,
    };

    vi.spyOn(Math, "random").mockReturnValue(1);
    const interceptor = new RetryInterceptor(config);
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    interceptor.intercept(fn, context);

    // With Math.random() = 1, delays are at their maximum
    await vi.advanceTimersByTimeAsync(1000); // 1st retry
    await vi.advanceTimersByTimeAsync(2000); // 2nd retry
    await vi.advanceTimersByTimeAsync(4000); // 3rd retry
    await vi.advanceTimersByTimeAsync(5000); // 4th retry (capped at maxDelay)

    expect(fn).toHaveBeenCalledTimes(5);

    vi.spyOn(Math, "random").mockRestore();
  });

  test("should not retry if signal is aborted", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 3,
      initialDelay: 1000,
    };
    const interceptor = new RetryInterceptor(config);

    const abortController = new AbortController();
    const contextWithSignal: InterceptorContext = {
      metadata: new Map(),
      signal: abortController.signal,
      userKey: "test",
    };

    const fn = vi.fn().mockImplementation(() => {
      abortController.abort(); // Abort after first call
      throw new Error("aborted");
    });

    const promise = interceptor.intercept(fn, contextWithSignal);

    // Await rejection and timer advancement simultaneously
    await Promise.all([
      expect(promise).rejects.toThrow("aborted"),
      vi.runAllTimersAsync(),
    ]);

    expect(fn).toHaveBeenCalledTimes(1); // Should not retry
  });

  test("should work with attempts = 1 (no retries)", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 1,
    };
    const interceptor = new RetryInterceptor(config);
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(interceptor.intercept(fn, context)).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("should apply full jitter: delay between 0 and capped value", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 3,
      initialDelay: 1000,
    };

    // At Math.random() = 0, delay = 1000 * 0 = 0ms (minimum)
    vi.spyOn(Math, "random").mockReturnValue(0);
    const interceptorMin = new RetryInterceptor(config);
    const fnMin = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");

    const promiseMin = interceptorMin.intercept(fnMin, context);
    await vi.advanceTimersByTimeAsync(0);
    await promiseMin;
    expect(fnMin).toHaveBeenCalledTimes(2);

    // At Math.random() = 1, delay = 1000 * 1 = 1000ms (maximum)
    vi.spyOn(Math, "random").mockReturnValue(1);
    const interceptorMax = new RetryInterceptor(config);
    const fnMax = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");

    interceptorMax.intercept(fnMax, context);
    await vi.advanceTimersByTimeAsync(999);
    expect(fnMax).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fnMax).toHaveBeenCalledTimes(2);

    vi.spyOn(Math, "random").mockRestore();
  });

  test("should produce jittered delay at midpoint", async () => {
    const config: RetryConfig = {
      enabled: true,
      attempts: 3,
      initialDelay: 1000,
    };

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const interceptor = new RetryInterceptor(config);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("success");

    interceptor.intercept(fn, context);

    // delay = 1000 * 0.5 = 500ms
    await vi.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.spyOn(Math, "random").mockRestore();
  });
});

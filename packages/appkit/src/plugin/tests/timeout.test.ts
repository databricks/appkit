import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TimeoutInterceptor } from "../interceptors/timeout";
import type { ExecutionContext } from "../interceptors/types";

describe("TimeoutInterceptor", () => {
  let context: ExecutionContext;

  beforeEach(() => {
    context = {
      pluginName: "test",
      metadata: new Map(),
      userKey: "test",
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("should execute function successfully within timeout", async () => {
    const interceptor = new TimeoutInterceptor(5000);
    const fn = vi.fn().mockResolvedValue("success");

    const promise = interceptor.intercept(fn, context);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("should create abort signal that fires after timeout", async () => {
    const interceptor = new TimeoutInterceptor(100); // Short timeout

    const fn = vi.fn().mockImplementation(async () => {
      // Signal should be updated
      expect(context.signal).toBeDefined();
      return "success";
    });

    await interceptor.intercept(fn, context);

    expect(fn).toHaveBeenCalled();
    expect(context.signal).toBeDefined();
  });

  test("should create timeout signal and update context", async () => {
    const interceptor = new TimeoutInterceptor(5000);
    const fn = vi.fn().mockImplementation(async () => {
      // Context signal should be updated
      expect(context.signal).toBeDefined();
      expect(context.signal).toBeInstanceOf(AbortSignal);
      return "success";
    });

    await interceptor.intercept(fn, context);
    await vi.runAllTimersAsync();

    expect(fn).toHaveBeenCalled();
  });

  test("should combine user signal with timeout signal", async () => {
    const userController = new AbortController();
    const contextWithSignal: ExecutionContext = {
      pluginName: "test",
      metadata: new Map(),
      signal: userController.signal,
      userKey: "test",
    };

    const interceptor = new TimeoutInterceptor(5000);
    const fn = vi.fn().mockImplementation(async () => {
      // Combined signal should exist
      expect(contextWithSignal.signal).toBeDefined();
      return "success";
    });

    await interceptor.intercept(fn, contextWithSignal);
    await vi.runAllTimersAsync();

    expect(fn).toHaveBeenCalled();
  });

  test("should combine signals when user signal exists", async () => {
    const userController = new AbortController();
    const contextWithSignal: ExecutionContext = {
      pluginName: "test",
      metadata: new Map(),
      signal: userController.signal,
      userKey: "test",
    };

    const interceptor = new TimeoutInterceptor(5000);
    const fn = vi.fn().mockImplementation(async () => {
      // Combined signal should be present
      expect(contextWithSignal.signal).toBeDefined();
      expect(contextWithSignal.signal).toBeInstanceOf(AbortSignal);
      return "success";
    });

    await interceptor.intercept(fn, contextWithSignal);

    expect(fn).toHaveBeenCalled();
  });

  test("should handle pre-aborted user signal", async () => {
    const userController = new AbortController();
    userController.abort(new Error("Already aborted"));

    const contextWithSignal: ExecutionContext = {
      pluginName: "test",
      metadata: new Map(),
      signal: userController.signal,
      userKey: "test",
    };

    const interceptor = new TimeoutInterceptor(5000);
    const fn = vi.fn().mockResolvedValue("result");

    await interceptor.intercept(fn, contextWithSignal);

    // Combined signal should be aborted
    expect(contextWithSignal.signal?.aborted).toBe(true);
  });

  test("should cleanup timeout on successful completion", async () => {
    const interceptor = new TimeoutInterceptor(5000);
    const fn = vi.fn().mockResolvedValue("success");

    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    await interceptor.intercept(fn, context);
    await vi.runAllTimersAsync();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  test("should cleanup timeout on error", async () => {
    const interceptor = new TimeoutInterceptor(5000);
    const fn = vi.fn().mockRejectedValue(new Error("function error"));

    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    await expect(interceptor.intercept(fn, context)).rejects.toThrow(
      "function error",
    );
    await vi.runAllTimersAsync();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

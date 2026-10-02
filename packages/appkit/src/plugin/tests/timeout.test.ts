import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ExecutionTimeoutError } from "../../errors/timeout";
import { executionFailure } from "../execution-result";
import { TimeoutInterceptor } from "../interceptors/timeout";
import type { InterceptorContext } from "../interceptors/types";

describe("TimeoutInterceptor", () => {
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

  test("recovers the timeout identity when an SDK discards the signal reason", async () => {
    const sdkError = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    const promise = new TimeoutInterceptor(100).intercept(
      () =>
        new Promise((_, reject) => {
          if (!context.signal) throw new Error("Missing execution signal");
          context.signal.addEventListener("abort", () => reject(sdkError));
        }),
      context,
    );
    const checked = expect(promise).rejects.toMatchObject({
      name: "ExecutionTimeoutError",
      errorCode: "TIMEOUT",
      cause: sdkError,
    });
    await vi.advanceTimersByTimeAsync(100);
    await checked;
  });

  test.each(["caller", "timeout"])(
    "preserves the first cancellation when %s wins",
    async (winner) => {
      const caller = new AbortController();
      context.signal = caller.signal;
      const sdkError = new DOMException(
        "The operation was aborted.",
        "AbortError",
      );
      let rejectOperation!: (error: Error) => void;
      const promise = new TimeoutInterceptor(100).intercept(
        () =>
          new Promise((_, reject) => {
            // Intentionally do not observe the signal until both sources
            // cancel: classification must not depend on SDK listeners.
            rejectOperation = reject;
          }),
        context,
      );
      if (winner === "caller") caller.abort();
      await vi.advanceTimersByTimeAsync(100);
      caller.abort();
      const checked =
        winner === "timeout"
          ? expect(promise).rejects.toBeInstanceOf(ExecutionTimeoutError)
          : expect(promise).rejects.toBe(sdkError);
      rejectOperation(sdkError);
      await checked;
    },
  );

  test.each(["success", "failure"])(
    "removes the caller listener after %s",
    async (outcome) => {
      const caller = new AbortController();
      context.signal = caller.signal;
      const add = vi.spyOn(caller.signal, "addEventListener");
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const failure = new Error("operation failed");
      const promise = new TimeoutInterceptor(100).intercept(
        () =>
          outcome === "success"
            ? Promise.resolve("ok")
            : Promise.reject(failure),
        context,
      );
      if (outcome === "success") await expect(promise).resolves.toBe("ok");
      else await expect(promise).rejects.toBe(failure);
      expect(add).toHaveBeenCalledExactlyOnceWith(
        "abort",
        expect.any(Function),
        { once: true },
      );
      expect(remove).toHaveBeenCalledExactlyOnceWith(
        "abort",
        add.mock.calls[0][1],
      );
      expect(vi.getTimerCount()).toBe(0);
      caller.abort();
      expect(context.signal?.aborted).toBe(false);
    },
  );

  test("retains the classified failure internally without serializing its cause", () => {
    const error = new ExecutionTimeoutError(100, new Error("private cause"));
    const result = executionFailure(error, 500, error.clientMessage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ok: false,
      status: 500,
      message: error.clientMessage,
    });
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
    const contextWithSignal: InterceptorContext = {
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
    const contextWithSignal: InterceptorContext = {
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

    const contextWithSignal: InterceptorContext = {
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

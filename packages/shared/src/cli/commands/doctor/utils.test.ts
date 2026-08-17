import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CHECK_TIMEOUT_MS,
  errorMessage,
  TimeoutError,
  withTimeout,
} from "./utils";

describe("errorMessage", () => {
  it("returns an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000)).resolves.toBe(
      "done",
    );
  });

  it("propagates the promise's own rejection unchanged", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("real failure")), 1000),
    ).rejects.toThrow("real failure");
  });

  it("rejects with TimeoutError when the promise hangs past the deadline", async () => {
    vi.useFakeTimers();
    // A promise that never settles — the classic reachable-but-unresponsive case.
    const hung = new Promise<string>(() => {});
    const raced = withTimeout(hung, 10_000);
    const assertion = expect(raced).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("defaults to the shared deadline", async () => {
    vi.useFakeTimers();
    const hung = new Promise<string>(() => {});
    const raced = withTimeout(hung);
    const assertion = expect(raced).rejects.toThrow(
      new RegExp(`${DEFAULT_CHECK_TIMEOUT_MS}ms`),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_TIMEOUT_MS);
    await assertion;
  });
});

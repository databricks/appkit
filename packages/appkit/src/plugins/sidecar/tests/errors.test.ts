import { describe, expect, test } from "vitest";
import { SidecarError } from "../../../errors/sidecar";

describe("SidecarError", () => {
  test("default statusCode is 503", () => {
    const err = new SidecarError("test");
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("SIDECAR_ERROR");
  });

  test("default isRetryable is true", () => {
    const err = new SidecarError("test");
    expect(err.isRetryable).toBe(true);
  });

  test("startupFailed is not retryable", () => {
    const err = SidecarError.startupFailed("python", 30000);
    expect(err.isRetryable).toBe(false);
    expect(err.message).toContain("python");
    expect(err.message).toContain("30000");
  });

  test("processCrashed is retryable", () => {
    const err = SidecarError.processCrashed("python", 1);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toContain("python");
  });

  test("maxRestartsExceeded is not retryable", () => {
    const err = SidecarError.maxRestartsExceeded("python", 5);
    expect(err.isRetryable).toBe(false);
    expect(err.message).toContain("5");
  });

  test("proxyFailed returns 502", () => {
    const err = SidecarError.proxyFailed();
    expect(err.statusCode).toBe(502);
    expect(err.isRetryable).toBe(true);
  });

  test("bridgeTimeout returns 504 and is retryable", () => {
    const err = SidecarError.bridgeTimeout(42, 5000);
    expect(err.statusCode).toBe(504);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toContain("42");
    expect(err.message).toContain("5000");
  });

  test("bridgeRequestFailed with code < -32000 is not retryable", () => {
    const err = SidecarError.bridgeRequestFailed("parse error", {
      code: -32001,
    });
    expect(err.statusCode).toBe(502);
    expect(err.isRetryable).toBe(false);
  });

  test("bridgeRequestFailed with code >= -32000 is retryable", () => {
    const err = SidecarError.bridgeRequestFailed("temp error", {
      code: -31999,
    });
    expect(err.statusCode).toBe(502);
    expect(err.isRetryable).toBe(true);
  });

  test("concurrencyExhausted returns 503 and is retryable", () => {
    const err = SidecarError.concurrencyExhausted(50);
    expect(err.statusCode).toBe(503);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toContain("50");
  });

  test("stdinWriteFailed returns 502 and is retryable", () => {
    const err = SidecarError.stdinWriteFailed();
    expect(err.statusCode).toBe(502);
    expect(err.isRetryable).toBe(true);
  });

  test("stdinWriteFailed preserves cause", () => {
    const cause = new Error("stream destroyed");
    const err = SidecarError.stdinWriteFailed(cause);
    expect(err.cause).toBe(cause);
  });

  test("context is preserved", () => {
    const err = SidecarError.bridgeTimeout(1, 5000);
    expect(err.context).toEqual(
      expect.objectContaining({
        requestId: 1,
        timeout: 5000,
        errorType: "bridge_timeout",
      }),
    );
  });
});

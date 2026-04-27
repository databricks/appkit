import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFetchError, PROBE_HARD_TIMEOUT, probeOnce } from "./probe";
import { createProbeServer, parseDurationParam } from "./server";

describe("classifyFetchError", () => {
  function abortedSignal(reason: unknown): AbortSignal {
    const c = new AbortController();
    c.abort(reason);
    return c.signal;
  }

  it("returns client-hard-timeout when the signal was aborted with PROBE_HARD_TIMEOUT", () => {
    // Reproduces Node 22's actual behaviour: fetch throws the abort reason
    // directly, NOT an AbortError-with-cause. The check has to walk the
    // signal, not the error.
    const err = PROBE_HARD_TIMEOUT;
    const result = classifyFetchError(
      err,
      abortedSignal(PROBE_HARD_TIMEOUT),
      false,
    );
    expect(result.outcome).toBe("client-hard-timeout");
  });

  it("returns server-close when bytes were received before the failure", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { message: "ECONNRESET" },
    });
    const result = classifyFetchError(err, new AbortController().signal, true);
    expect(result.outcome).toBe("server-close");
    expect(result.detail).toBe("ECONNRESET");
  });

  it("returns network-error when the failure happened before any bytes arrived", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { message: "ENOTFOUND" },
    });
    const result = classifyFetchError(err, new AbortController().signal, false);
    expect(result.outcome).toBe("network-error");
    expect(result.detail).toBe("ENOTFOUND");
  });

  it("does NOT misclassify aborts with other reasons as client-hard-timeout", () => {
    // If something else aborts the signal (test harness, parent abort), the
    // probe must not silently call it a client-hard-timeout.
    const result = classifyFetchError(
      new Error("oops"),
      abortedSignal(new Error("unrelated")),
      true,
    );
    expect(result.outcome).toBe("server-close");
  });

  it("falls back to e.message when there is no underlying .cause", () => {
    const result = classifyFetchError(
      new Error("plain fetch error"),
      new AbortController().signal,
      false,
    );
    expect(result.detail).toBe("plain fetch error");
  });
});

describe("parseDurationParam", () => {
  it("uses the default for null/empty/non-numeric inputs", () => {
    expect(parseDurationParam(null, 120_000, 60 * 60_000)).toBe(120_000);
    expect(parseDurationParam("", 120_000, 60 * 60_000)).toBe(120_000);
    expect(parseDurationParam("not-a-number", 120_000, 60 * 60_000)).toBe(
      120_000,
    );
  });

  it("uses the default for negative values", () => {
    expect(parseDurationParam("-100", 120_000, 60 * 60_000)).toBe(120_000);
  });

  it("uses the default for NaN-producing inputs (this guards against the 1ms-setTimeout bug)", () => {
    // Math.max(0, NaN) === NaN, and setTimeout(..., NaN) collapses to 1ms,
    // which would produce a tight heartbeat loop and bogus measurements.
    expect(parseDurationParam("abc", 120_000, 60 * 60_000)).toBe(120_000);
  });

  it("clamps to the max", () => {
    expect(parseDurationParam("999999999", 120_000, 60 * 60_000)).toBe(
      60 * 60_000,
    );
  });

  it("passes through valid in-range values", () => {
    expect(parseDurationParam("30000", 120_000, 60 * 60_000)).toBe(30_000);
  });
});

describe("probeOnce (integration via in-process server)", () => {
  let server: ReturnType<typeof createProbeServer>;
  let baseUrl: string;

  beforeEach(async () => {
    server = createProbeServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports `completed` when the server holds the connection for the full target", async () => {
    const result = await probeOnce(
      {
        baseUrl,
        path: "/sse-probe",
        durationsMs: [200],
        heartbeatMs: 0,
        headers: {},
        jsonOutput: false,
      },
      200,
    );
    expect(result.outcome).toBe("completed");
    expect(result.actualLifetimeMs).toBeGreaterThanOrEqual(150);
  });

  it("reports `wrong-content-type` when the endpoint isn't an SSE stream", async () => {
    // Probe a 404 path so the server returns text/plain, not text/event-stream.
    const result = await probeOnce(
      {
        baseUrl,
        path: "/nope",
        durationsMs: [200],
        heartbeatMs: 0,
        headers: {},
        jsonOutput: false,
      },
      200,
    );
    expect(["wrong-content-type", "server-close"]).toContain(result.outcome);
  });
});

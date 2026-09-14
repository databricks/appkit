import { describe, expect, test } from "vitest";

import { runWithRetries } from "../run-evals";
import type { EvalResult } from "../types";

describe("runWithRetries", () => {
  // Disable the inter-attempt backoff so these count-based tests stay instant.
  const noBackoff = { baseDelayMs: 0 };

  const errored = (n: number): EvalResult => ({
    id: `try-${n}`,
    assertions: [],
    passed: false,
    error: "turn failed",
  });
  const ok = (n: number): EvalResult => ({
    id: `try-${n}`,
    assertions: [],
    passed: true,
  });
  const assertionFail = (n: number): EvalResult => ({
    id: `try-${n}`,
    assertions: [{ label: "check", severity: "gate", pass: false }],
    passed: false,
  });
  const infraFailed = (n: number): EvalResult => ({
    id: `try-${n}`,
    assertions: [],
    passed: false,
    infraFailure: true,
  });

  test("retries an infra error up to `retries` extra times, then returns the last", async () => {
    let calls = 0;
    const result = await runWithRetries(
      2,
      async (n) => {
        calls = n;
        return errored(n);
      },
      noBackoff,
    );
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(result.error).toBe("turn failed");
  });

  test("stops as soon as an attempt succeeds", async () => {
    let calls = 0;
    const result = await runWithRetries(
      5,
      async (n) => {
        calls = n;
        return n < 2 ? errored(n) : ok(n);
      },
      noBackoff,
    );
    expect(calls).toBe(2); // errored once, then ok
    expect(result.passed).toBe(true);
  });

  test("never retries an assertion failure (no error set)", async () => {
    let calls = 0;
    const result = await runWithRetries(
      3,
      async (n) => {
        calls = n;
        return assertionFail(n);
      },
      noBackoff,
    );
    expect(calls).toBe(1);
    expect(result.passed).toBe(false);
  });

  test("retries=0 runs exactly once", async () => {
    let calls = 0;
    await runWithRetries(
      0,
      async (n) => {
        calls = n;
        return errored(n);
      },
      noBackoff,
    );
    expect(calls).toBe(1);
  });

  test("coerces a non-finite retries to 0 (runs exactly once)", async () => {
    let calls = 0;
    await runWithRetries(
      Number.NaN,
      async (n) => {
        calls = n;
        return infraFailed(n);
      },
      noBackoff,
    );
    expect(calls).toBe(1);
  });

  test("retries a transport/agent turn failure (infraFailure) like an error", async () => {
    let calls = 0;
    const result = await runWithRetries(
      2,
      async (n) => {
        calls = n;
        return infraFailed(n);
      },
      noBackoff,
    );
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(result.infraFailure).toBe(true);
  });

  test("stops retrying once an infra-failed turn recovers", async () => {
    let calls = 0;
    const result = await runWithRetries(
      5,
      async (n) => {
        calls = n;
        return n < 2 ? infraFailed(n) : ok(n);
      },
      noBackoff,
    );
    expect(calls).toBe(2);
    expect(result.passed).toBe(true);
  });
});

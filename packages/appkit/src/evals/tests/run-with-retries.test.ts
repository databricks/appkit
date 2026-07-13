import { describe, expect, test } from "vitest";

import { runWithRetries } from "../run-evals";
import type { EvalResult } from "../types";

describe("runWithRetries", () => {
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

  test("retries an infra error up to `retries` extra times, then returns the last", async () => {
    let calls = 0;
    const result = await runWithRetries(2, async (n) => {
      calls = n;
      return errored(n);
    });
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(result.error).toBe("turn failed");
  });

  test("stops as soon as an attempt succeeds", async () => {
    let calls = 0;
    const result = await runWithRetries(5, async (n) => {
      calls = n;
      return n < 2 ? errored(n) : ok(n);
    });
    expect(calls).toBe(2); // errored once, then ok
    expect(result.passed).toBe(true);
  });

  test("never retries an assertion failure (no error set)", async () => {
    let calls = 0;
    const result = await runWithRetries(3, async (n) => {
      calls = n;
      return assertionFail(n);
    });
    expect(calls).toBe(1);
    expect(result.passed).toBe(false);
  });

  test("retries=0 runs exactly once", async () => {
    let calls = 0;
    await runWithRetries(0, async (n) => {
      calls = n;
      return errored(n);
    });
    expect(calls).toBe(1);
  });
});

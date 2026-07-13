import { describe, expect, test } from "vitest";
import { runBounded, runWithRetries } from "../run-evals";
import type { EvalResult } from "../types";

/** Resolve after `ms`, yielding to the event loop. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("runBounded", () => {
  test("preserves input order regardless of completion order", async () => {
    // Later items finish first, so completion order is the reverse of input.
    const inputs = [40, 30, 20, 10, 0];
    const results = await runBounded(inputs, 5, async (ms, i) => {
      await delay(ms);
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  test("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, (_, i) => i);
    const results = await runBounded(tasks, 3, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return i * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual(tasks.map((i) => i * 2));
  });

  test("runs serially at limit 1 and clamps limits below 1", async () => {
    const order: number[] = [];
    for (const limit of [1, 0, -3]) {
      order.length = 0;
      let active = 0;
      let peak = 0;
      await runBounded([0, 1, 2], limit, async (i) => {
        active++;
        peak = Math.max(peak, active);
        await delay(1);
        order.push(i);
        active--;
        return i;
      });
      expect(peak).toBe(1);
      expect(order).toEqual([0, 1, 2]);
    }
  });

  test("more workers than tasks is fine and stays ordered", async () => {
    const results = await runBounded([2, 1], 10, async (ms, i) => {
      await delay(ms);
      return i;
    });
    expect(results).toEqual([0, 1]);
  });

  test("empty task list resolves to an empty array", async () => {
    const results = await runBounded([], 4, async (x) => x);
    expect(results).toEqual([]);
  });
});

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

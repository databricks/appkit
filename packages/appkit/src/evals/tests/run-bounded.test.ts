import { describe, expect, test } from "vitest";
import { runBounded } from "../run-evals";

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

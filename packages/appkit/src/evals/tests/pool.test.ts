import { describe, expect, test } from "vitest";

import { mapPool } from "../pool";

describe("mapPool", () => {
  test("preserves input order even when later items finish first", async () => {
    // Earlier items sleep longer, so they resolve after later ones.
    const out = await mapPool([30, 20, 10, 0], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapPool(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return null;
      },
    );
    expect(maxInFlight).toBe(3);
  });

  test("processes every item exactly once", async () => {
    const seen: number[] = [];
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("clamps concurrency to [1, length] and handles empty input", async () => {
    expect(await mapPool([1, 2], 99, async (n) => n)).toEqual([1, 2]);
    expect(await mapPool<number, number>([], 4, async (n) => n)).toEqual([]);
  });

  test("coerces a non-finite concurrency (NaN) to 1 instead of skipping every item", async () => {
    // A bad CLI `--concurrency abc` reaches here as NaN. Without coercion,
    // zero workers spawn and every item is silently skipped (undefined holes).
    const seen: number[] = [];
    const out = await mapPool([1, 2, 3], Number.NaN, async (n) => {
      seen.push(n);
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30]);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

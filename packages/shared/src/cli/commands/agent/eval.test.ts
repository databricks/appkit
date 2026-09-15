import { describe, expect, test } from "vitest";

import { parsePassRate } from "./eval";

describe("parsePassRate", () => {
  test("returns undefined when the flag is unset", () => {
    expect(parsePassRate(undefined)).toBeUndefined();
  });

  test("accepts a value in [0, 1]", () => {
    expect(parsePassRate("0")).toBe(0);
    expect(parsePassRate("0.8")).toBe(0.8);
    expect(parsePassRate("1")).toBe(1);
  });

  test.each(["", "   ", "-1", "2", "90", "abc", "0.5junk", "NaN", "Infinity"])(
    "rejects blank, out-of-range, or non-numeric %j",
    (raw) => {
      expect(() => parsePassRate(raw)).toThrow(/min-pass-rate/);
    },
  );
});

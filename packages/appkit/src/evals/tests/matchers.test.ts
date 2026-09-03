import { describe, expect, test } from "vitest";

import { equals, includes, matches } from "../matchers";

describe("eval matchers", () => {
  test("includes", () => {
    expect(includes("Sunny")("It is Sunny today").pass).toBe(true);
    expect(includes("Rainy")("It is Sunny today").pass).toBe(false);
  });

  test("equals", () => {
    expect(equals("yes")("yes").pass).toBe(true);
    expect(equals("yes")("Yes").pass).toBe(false);
  });

  test("matches", () => {
    expect(matches(/^\d+ rows$/)("42 rows").pass).toBe(true);
    expect(matches(/^\d+ rows$/)("forty rows").pass).toBe(false);
  });
});

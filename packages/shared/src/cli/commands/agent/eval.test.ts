import { describe, expect, test } from "vitest";

import { parsePassRate, withAppAuth } from "./eval";

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

describe("withAppAuth", () => {
  const app = "https://my-app-123.staging.aws.databricksapps.com";

  test("adds the bearer for a deployed app, keeping other headers", () => {
    expect(withAppAuth(app, { "X-Test": "1" }, "tok")).toEqual({
      "X-Test": "1",
      Authorization: "Bearer tok",
    });
  });

  test("an explicit Authorization header wins", () => {
    const headers = { authorization: "Bearer mine" };
    expect(withAppAuth(app, headers, "tok")).toBe(headers);
  });

  test.each([
    ["http://localhost:8000", "tok"],
    ["http://my-app.databricksapps.com", "tok"],
    ["https://evil.example.com", "tok"],
    ["https://databricksapps.com.evil.com", "tok"],
    ["not a url", "tok"],
    [app, undefined],
  ])("leaves headers untouched for %s (token %s)", (url, token) => {
    expect(withAppAuth(url, undefined, token)).toBeUndefined();
  });
});

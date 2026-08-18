import { describe, expect, test } from "vitest";

import { MAX_UC_OBJECT_NAME_LENGTH, UC_FQN_PATTERN } from "./metric-fqn";

/**
 * UC_FQN_PATTERN matches a single Unity Catalog object name as it may appear in
 * a backtick-quoted (delimited) identifier. The rule (per
 * https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-names) is:
 * any non-empty name EXCEPT one containing a period, a space, a forward slash,
 * an ASCII control character (U+0000-U+001F), or DELETE (U+007F).
 *
 * These tables encode "accept what UC accepts as a quoted name, reject only
 * what UC rejects" — deliberately broader than the old hand-rolled allowlist
 * `[a-zA-Z0-9_-]`, which PR #433 review (pkosiec) flagged as "more restrictive
 * than UC".
 */
describe("UC_FQN_PATTERN", () => {
  test("the object-name length cap is UC's 255", () => {
    expect(MAX_UC_OBJECT_NAME_LENGTH).toBe(255);
  });

  describe("accepts UC-valid object names", () => {
    const valid: Array<[label: string, name: string]> = [
      ["plain lowercase", "revenue"],
      ["snake_case with underscore", "revenue_metrics"],
      ["leading underscore", "_internal"],
      ["mixed case", "RevenueMetrics"],
      ["digits", "metrics_2024"],
      ["all digits (delimited names may start with a digit)", "123"],
      ["hyphenated catalog", "prod-data"],
      ["single character", "a"],
      // ── Regression cases: characters OUTSIDE [a-zA-Z0-9_-] that UC permits
      // in a quoted identifier and the OLD regex wrongly rejected (PR #433
      // review, pkosiec: "more restrictive than UC"). ─────────────────────
      ["accented latin (é)", "café"],
      ["CJK characters", "指标"],
      ["cyrillic", "выручка"],
      ["parentheses", "metrics(v2)"],
      ["plus and at", "a+b@c"],
      ["dollar and percent", "cost$_pct%"],
      ["colon", "ns:metric"],
      ["255-char name (exactly at the UC cap)", "a".repeat(255)],
    ];
    test.each(valid)("%s: %j", (_label, name) => {
      expect(UC_FQN_PATTERN.test(name)).toBe(true);
    });
  });

  describe("rejects UC-illegal object names", () => {
    const invalid: Array<[label: string, name: string]> = [
      ["empty string", ""],
      ["contains a space", "bad name"],
      ["leading space", " leading"],
      ["trailing space", "trailing "],
      ["contains a forward slash", "a/b"],
      ["contains a period (FQN separator)", "a.b"],
      ["tab (control char)", "a\tb"],
      ["newline (control char)", "a\nb"],
      ["carriage return (control char)", "a\rb"],
      ["NUL (C0 control)", "a\x00b"],
      ["unit separator (U+001F, top of control range)", "a\x1fb"],
      ["DELETE (U+007F)", "a\x7fb"],
    ];
    test.each(invalid)("%s: %j", (_label, name) => {
      expect(UC_FQN_PATTERN.test(name)).toBe(false);
    });
  });

  test("length is intentionally NOT bounded by the pattern (callers cap it)", () => {
    // The pattern only encodes the allowed character set; a 256-char all-legal
    // name still matches. resolveMetricConfig enforces MAX_UC_OBJECT_NAME_LENGTH
    // separately so it can emit a precise "segment too long" message.
    expect(UC_FQN_PATTERN.test("a".repeat(256))).toBe(true);
  });

  test("the boundary characters around the prohibited ranges are accepted", () => {
    // U+0021 '!' sits one past the space at U+0020 (lowest printable ASCII);
    // U+007E '~' sits one below DELETE at U+007F (highest printable ASCII).
    // Both are legal — proving the negated ranges stop exactly where UC says.
    expect(UC_FQN_PATTERN.test("!")).toBe(true);
    expect(UC_FQN_PATTERN.test("~")).toBe(true);
  });
});

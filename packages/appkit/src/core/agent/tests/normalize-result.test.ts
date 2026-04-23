import { describe, expect, test } from "vitest";
import {
  MAX_TOOL_RESULT_CHARS,
  normalizeToolResult,
} from "../normalize-result";

describe("normalizeToolResult", () => {
  test("maps undefined to empty string so void tools don't surface as errors", () => {
    expect(normalizeToolResult(undefined)).toBe("");
  });

  test("returns strings unchanged", () => {
    expect(normalizeToolResult("hello")).toBe("hello");
  });

  test("leaves non-string results intact (caller serialises)", () => {
    const result = normalizeToolResult({ rows: 2, ok: true });
    expect(result).toEqual({ rows: 2, ok: true });
  });

  test("returns an empty string input as an empty string (not undefined)", () => {
    expect(normalizeToolResult("")).toBe("");
  });

  test("preserves null without converting to empty string", () => {
    expect(normalizeToolResult(null)).toBeNull();
  });

  test("truncates long strings and appends a marker with the original length", () => {
    const big = "x".repeat(MAX_TOOL_RESULT_CHARS + 1000);
    const result = normalizeToolResult(big);
    expect(typeof result).toBe("string");
    const s = result as string;
    // Content portion is bounded to MAX_TOOL_RESULT_CHARS (plus the marker).
    expect(s.slice(0, MAX_TOOL_RESULT_CHARS)).toBe(
      "x".repeat(MAX_TOOL_RESULT_CHARS),
    );
    expect(s).toMatch(
      new RegExp(
        `\\[Result truncated: ${big.length} chars exceeds ${MAX_TOOL_RESULT_CHARS} limit\\]`,
      ),
    );
  });

  test("truncates long serialised objects the same way", () => {
    const big = { blob: "x".repeat(MAX_TOOL_RESULT_CHARS + 10) };
    const result = normalizeToolResult(big);
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/\[Result truncated:/);
  });

  test("honours a custom maxChars parameter", () => {
    const result = normalizeToolResult("hello world", 5);
    expect(result).toBe(
      "hello\n\n[Result truncated: 11 chars exceeds 5 limit]",
    );
  });

  test("does not truncate at the boundary (exact length is fine)", () => {
    const s = "x".repeat(MAX_TOOL_RESULT_CHARS);
    expect(normalizeToolResult(s)).toBe(s);
  });
});

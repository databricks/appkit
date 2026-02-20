import { describe, expect, test } from "vitest";
import {
  isSafeInlineContentType,
  SAFE_INLINE_CONTENT_TYPES,
} from "../defaults";

describe("isSafeInlineContentType", () => {
  const safeTypes = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/vnd.microsoft.icon",
    "text/plain",
    "text/csv",
    "text/markdown",
    "application/json",
    "application/pdf",
  ];

  for (const type of safeTypes) {
    test(`returns true for safe type: ${type}`, () => {
      expect(isSafeInlineContentType(type)).toBe(true);
    });
  }

  const dangerousTypes = [
    "text/html",
    "text/javascript",
    "image/svg+xml",
    "text/css",
    "application/xml",
  ];

  for (const type of dangerousTypes) {
    test(`returns false for dangerous type: ${type}`, () => {
      expect(isSafeInlineContentType(type)).toBe(false);
    });
  }

  test("returns false for unknown types", () => {
    expect(isSafeInlineContentType("application/octet-stream")).toBe(false);
    expect(isSafeInlineContentType("application/x-yaml")).toBe(false);
    expect(isSafeInlineContentType("video/mp4")).toBe(false);
  });

  test("SAFE_INLINE_CONTENT_TYPES is frozen (ReadonlySet)", () => {
    expect(SAFE_INLINE_CONTENT_TYPES.size).toBe(safeTypes.length);
    for (const type of safeTypes) {
      expect(SAFE_INLINE_CONTENT_TYPES.has(type)).toBe(true);
    }
  });
});

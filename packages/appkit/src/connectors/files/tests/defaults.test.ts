import { describe, expect, test } from "vitest";
import {
  contentTypeFromPath,
  isSafeInlineContentType,
  SAFE_INLINE_CONTENT_TYPES,
  validateCustomContentTypes,
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

describe("contentTypeFromPath", () => {
  test("returns octet-stream for files without an extension", () => {
    expect(contentTypeFromPath("Makefile")).toBe("application/octet-stream");
    expect(contentTypeFromPath("/path/to/Makefile")).toBe(
      "application/octet-stream",
    );
  });

  test("falls back to reported type for files without an extension", () => {
    expect(contentTypeFromPath("LICENSE", "text/plain")).toBe("text/plain");
  });

  test("returns octet-stream for dotfiles without a real extension", () => {
    expect(contentTypeFromPath(".gitignore")).toBe("application/octet-stream");
    expect(contentTypeFromPath(".env")).toBe("application/octet-stream");
  });

  test("resolves dotfiles that have an extension", () => {
    expect(contentTypeFromPath(".eslintrc.json")).toBe("application/json");
    expect(contentTypeFromPath(".config.yaml")).toBe("application/x-yaml");
  });

  test("returns octet-stream for empty string", () => {
    expect(contentTypeFromPath("")).toBe("application/octet-stream");
  });
});

describe("validateCustomContentTypes", () => {
  test("accepts safe MIME types", () => {
    expect(() =>
      validateCustomContentTypes({
        ".csv": "text/csv",
        ".custom": "application/x-custom",
        ".img": "image/png",
      }),
    ).not.toThrow();
  });

  test("rejects text/html", () => {
    expect(() => validateCustomContentTypes({ ".htm": "text/html" })).toThrow(
      "text/html",
    );
  });

  test("rejects text/javascript", () => {
    expect(() =>
      validateCustomContentTypes({ ".mjs": "text/javascript" }),
    ).toThrow("text/javascript");
  });

  test("rejects application/javascript", () => {
    expect(() =>
      validateCustomContentTypes({ ".js": "application/javascript" }),
    ).toThrow("application/javascript");
  });

  test("rejects image/svg+xml", () => {
    expect(() =>
      validateCustomContentTypes({ ".svg": "image/svg+xml" }),
    ).toThrow("image/svg+xml");
  });

  test("rejects application/xhtml+xml", () => {
    expect(() =>
      validateCustomContentTypes({ ".xhtml": "application/xhtml+xml" }),
    ).toThrow("application/xhtml+xml");
  });

  test("rejects dangerous types case-insensitively", () => {
    expect(() => validateCustomContentTypes({ ".htm": "Text/HTML" })).toThrow(
      "text/html",
    );
  });

  test("accepts empty map", () => {
    expect(() => validateCustomContentTypes({})).not.toThrow();
  });
});

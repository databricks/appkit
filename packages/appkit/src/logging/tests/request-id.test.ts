import { describe, expect, test } from "vitest";
import {
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_PATTERN,
  sanitizeRequestId,
} from "../request-id";

describe("sanitizeRequestId", () => {
  test("accepts simple alphanumeric IDs", () => {
    expect(sanitizeRequestId("abc123")).toBe("abc123");
  });

  test("accepts IDs with internal hyphens, underscores, and dots", () => {
    expect(sanitizeRequestId("trace.abc-123_xyz")).toBe("trace.abc-123_xyz");
  });

  test("accepts IDs at the maximum length", () => {
    const id = "a".repeat(MAX_REQUEST_ID_LENGTH);
    expect(sanitizeRequestId(id)).toBe(id);
  });

  test("rejects IDs over the maximum length", () => {
    expect(sanitizeRequestId("a".repeat(MAX_REQUEST_ID_LENGTH + 1))).toBe(
      undefined,
    );
  });

  test("rejects IDs starting with a dash (potential shell-flag confusion)", () => {
    expect(sanitizeRequestId("-rf")).toBe(undefined);
    expect(sanitizeRequestId("--help")).toBe(undefined);
  });

  test("rejects IDs starting with an underscore", () => {
    expect(sanitizeRequestId("_internal")).toBe(undefined);
  });

  test("rejects IDs starting with a dot", () => {
    expect(sanitizeRequestId(".bad")).toBe(undefined);
  });

  test("rejects empty string", () => {
    expect(sanitizeRequestId("")).toBe(undefined);
  });

  test("rejects values with characters outside the allowlist", () => {
    expect(sanitizeRequestId("abc def")).toBe(undefined); // space
    expect(sanitizeRequestId("abc/def")).toBe(undefined); // slash
    expect(sanitizeRequestId("abc:def")).toBe(undefined); // colon
  });

  test("rejects CRLF-injection attempts (CWE-117)", () => {
    expect(sanitizeRequestId("attacker\r\nSet-Cookie: pwn=1")).toBe(undefined);
    expect(sanitizeRequestId("a\nb")).toBe(undefined);
    expect(sanitizeRequestId("a\rb")).toBe(undefined);
  });

  test("REQUEST_ID_PATTERN is exported and matches sanitizeRequestId", () => {
    expect(REQUEST_ID_PATTERN.test("abc123")).toBe(true);
    expect(REQUEST_ID_PATTERN.test(".bad")).toBe(false);
    expect(REQUEST_ID_PATTERN.test("a".repeat(MAX_REQUEST_ID_LENGTH + 1))).toBe(
      false,
    );
  });
});

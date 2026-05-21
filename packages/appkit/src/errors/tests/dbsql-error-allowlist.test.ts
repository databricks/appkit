import { describe, expect, test } from "vitest";
import { isSqlErrorPassthrough } from "../dbsql-error-allowlist";

describe("isSqlErrorPassthrough", () => {
  // Allowlist members — DBR-authored, user-facing messages.
  test.each([
    ["BAD_REQUEST"],
    ["NOT_FOUND"],
    ["ALREADY_EXISTS"],
    ["DEADLINE_EXCEEDED"],
    ["CANCELLED"],
    ["UNAUTHENTICATED"],
  ])("%s is allowlisted (DBR-authored user-facing message)", (code) => {
    expect(isSqlErrorPassthrough(code)).toBe(true);
  });

  // Explicit denylist — control-plane sourced, internal state risk.
  test.each([
    ["INTERNAL_ERROR"],
    ["IO_ERROR"],
    ["UNKNOWN"],
    ["RESOURCE_EXHAUSTED"],
    ["SERVICE_UNDER_MAINTENANCE"],
    ["TEMPORARILY_UNAVAILABLE"],
    ["WORKSPACE_TEMPORARILY_UNAVAILABLE"],
    ["ABORTED"],
  ])(
    "%s is denied (control-plane sourced, may carry internal state)",
    (code) => {
      expect(isSqlErrorPassthrough(code)).toBe(false);
    },
  );

  test("undefined and empty string are denied (default-deny on missing source)", () => {
    expect(isSqlErrorPassthrough(undefined)).toBe(false);
    expect(isSqlErrorPassthrough("")).toBe(false);
  });

  test("any unrecognized code (e.g. new SDK additions) is denied", () => {
    // When the SDK ships a new ServiceErrorCode variant, the allowlist
    // must default-deny it until a human reviews the upstream message
    // source. This test pins the default-deny behavior.
    expect(isSqlErrorPassthrough("BRAND_NEW_CODE")).toBe(false);
    expect(isSqlErrorPassthrough("PERMISSION_DENIED")).toBe(false);
    expect(isSqlErrorPassthrough("FOOBAR")).toBe(false);
  });

  test("case-sensitive match — codes from the SDK are SHOUTY_CASE, lowercased input is rejected", () => {
    // Defensive: if an upstream layer ever lowercases the code, we
    // want the allowlist to fail closed rather than silently match.
    expect(isSqlErrorPassthrough("bad_request")).toBe(false);
    expect(isSqlErrorPassthrough("Bad_Request")).toBe(false);
  });
});

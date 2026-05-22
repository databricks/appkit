import { describe, expect, test } from "vitest";
import { isSqlErrorPassthrough } from "../dbsql-error-allowlist";

describe("isSqlErrorPassthrough", () => {
  // Allowlist members — designed-for-user messages.
  test.each([
    // DBR data plane — user's own SQL errors.
    ["BAD_REQUEST"],
    ["NOT_FOUND"],
    ["ALREADY_EXISTS"],
    // SDK-level codes with generic templates.
    ["DEADLINE_EXCEEDED"],
    ["CANCELLED"],
    ["UNAUTHENTICATED"],
    // 5xx-class service messages — stable user-facing templates
    // ("DBSQL temporarily unavailable. Please try again in a few
    // minutes."). Hiding these forces users to guess whether a failure
    // is on their side or ours.
    ["TEMPORARILY_UNAVAILABLE"],
    ["WORKSPACE_TEMPORARILY_UNAVAILABLE"],
    ["SERVICE_UNDER_MAINTENANCE"],
    // Quota — stable user-actionable templates ("Stop or delete
    // existing warehouses to free up capacity.").
    ["RESOURCE_EXHAUSTED"],
    // Concurrency conflict — short reason strings, user-relevant for
    // retry decisions.
    ["ABORTED"],
  ])("%s is allowlisted (designed-for-user message)", (code) => {
    expect(isSqlErrorPassthrough(code)).toBe(true);
  });

  // Explicit denylist — designed-for-debugging, interpolates internal
  // identifiers, stack traces, or storage paths.
  test.each([["INTERNAL_ERROR"], ["IO_ERROR"], ["UNKNOWN"]])(
    "%s is denied (designed-for-debugging, interpolates internal state)",
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

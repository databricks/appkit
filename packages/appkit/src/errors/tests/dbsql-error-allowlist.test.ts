import { describe, expect, test } from "vitest";
import { isSqlErrorPassthrough } from "../dbsql-error-allowlist";

describe("isSqlErrorPassthrough", () => {
  // Allowlist members — passthrough is net-positive given the
  // workspace-user threat model (recipient already knows the workspace's
  // resources). Server-side full-detail logging + the requestId on the
  // SSE error frame backstop the unhappy cases.
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
    // Concurrency conflict — short reason strings, user-relevant.
    ["ABORTED"],
    // Wrapped internal exceptions — interpolated identifiers (orgId,
    // warehouse name) are non-sensitive to an authenticated workspace
    // user; the wrapped `ex.getMessage` content is operationally
    // useful for triage. RequestId on the SSE error frame is the
    // safety net for unhappy cases.
    ["INTERNAL_ERROR"],
    ["IO_ERROR"],
  ])("%s is allowlisted", (code) => {
    expect(isSqlErrorPassthrough(code)).toBe(true);
  });

  // Only UNKNOWN stays denied — unclassified by definition, so the
  // wrapped content is unbounded in shape AND in source.
  test("UNKNOWN is denied (unclassified — cannot reason about contents)", () => {
    expect(isSqlErrorPassthrough("UNKNOWN")).toBe(false);
  });

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

import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vitest";

import { shouldExcludePath, shouldIgnoreRequest } from "../path-exclusions";

describe("shouldExcludePath", () => {
  test.each(["/health", "/@vite/client", "/assets/index.css"])(
    "excludes %s",
    (path) => {
      expect(shouldExcludePath(path)).toBe(true);
    },
  );

  test.each(["/_analytics/v1/logs", "/_analytics/v1/logs?batch=1"])(
    "excludes the App Analytics relay path %s",
    (path) => {
      expect(shouldExcludePath(path)).toBe(true);
    },
  );

  test.each([
    "/api/analytics/query/spend",
    "/analytics",
    "/",
    // App routes that merely contain the App Analytics prefix keep telemetry.
    "/api/reports/_analytics/v1/summary",
    "/reports/_analytics/v1/logs",
    // Only the versioned paths App Analytics serves are excluded.
    "/_analytics/admin",
  ])("keeps %s", (path) => {
    expect(shouldExcludePath(path)).toBe(false);
  });

  test("keeps a missing path", () => {
    expect(shouldExcludePath(undefined)).toBe(false);
  });
});

describe("shouldIgnoreRequest", () => {
  test("ignores incoming App Analytics relay requests", () => {
    expect(
      shouldIgnoreRequest({
        url: "/_analytics/v1/logs",
      } as IncomingMessage),
    ).toBe(true);
  });

  test("keeps SQL analytics plugin requests", () => {
    expect(
      shouldIgnoreRequest({
        url: "/api/analytics/query/spend?format=JSON",
      } as IncomingMessage),
    ).toBe(false);
  });
});

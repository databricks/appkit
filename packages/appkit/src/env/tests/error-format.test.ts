import { describe, expect, it } from "vitest";
import { formatEnvErrors } from "../errors";
import type { EnvValidationIssue } from "../types";

describe("formatEnvErrors", () => {
  it("returns neutral message for no issues", () => {
    expect(formatEnvErrors([])).toBe("No environment variable issues");
  });

  it("formats a single issue", () => {
    const issues: EnvValidationIssue[] = [{ key: "HOST", message: "Required" }];

    const result = formatEnvErrors(issues);
    expect(result).toContain("HOST");
    expect(result).toContain("Required");
    expect(result).toContain("Invalid environment variables:");
  });

  it("formats multiple issues", () => {
    const issues: EnvValidationIssue[] = [
      { key: "HOST", message: "Required" },
      {
        key: "PORT",
        message: "Expected number, received string",
        received: "abc",
      },
    ];

    const result = formatEnvErrors(issues);
    expect(result).toContain("HOST");
    expect(result).toContain("PORT");
    expect(result).toContain('"abc"');
  });

  it("includes received value when present", () => {
    const issues: EnvValidationIssue[] = [
      { key: "MODE", message: "Invalid enum value", received: "invalid" },
    ];

    const result = formatEnvErrors(issues);
    expect(result).toContain('(received: "invalid")');
  });

  it("omits received value when undefined", () => {
    const issues: EnvValidationIssue[] = [
      { key: "MISSING", message: "Required" },
    ];

    const result = formatEnvErrors(issues);
    expect(result).not.toContain("received");
  });
});

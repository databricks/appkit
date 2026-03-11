import { ConfigurationError } from "../errors";
import type { EnvValidationIssue } from "./types";

/**
 * Formats env validation issues into a human-readable box banner,
 * consistent with ResourceRegistry.formatDevWarningBanner.
 */
export function formatEnvErrors(issues: EnvValidationIssue[]): string {
  if (issues.length === 0) {
    return "No environment variable issues";
  }

  const lines: string[] = [
    "Invalid environment variables:",
    "",
    ...issues.map(
      (issue) =>
        `  ${issue.key}: ${issue.message}${issue.received !== undefined ? ` (received: ${JSON.stringify(issue.received)})` : ""}`,
    ),
  ];

  return lines.join("\n");
}

/**
 * Throws a ConfigurationError with formatted env validation issues.
 */
export function throwEnvError(issues: EnvValidationIssue[]): never {
  throw new ConfigurationError(formatEnvErrors(issues), {
    context: {
      invalidEnvVars: issues.map((i) => i.key),
    },
  });
}

import { describe, expect, test } from "vitest";
import { normalizeTelemetryOptions } from "../config";

describe("normalizeTelemetryOptions", () => {
  test.each([
    {
      description:
        "should return all enabled when config is undefined (default)",
      input: undefined,
      expected: { traces: true, metrics: true, logs: true },
    },
    {
      description: "should return config object as-is when provided",
      input: { traces: true, metrics: false, logs: true },
      expected: { traces: true, metrics: false, logs: true },
    },
    {
      description: "should handle all traces/metrics/logs disabled in object",
      input: { traces: false, metrics: false, logs: false },
      expected: { traces: false, metrics: false, logs: false },
    },
    {
      description: "should handle all traces/metrics/logs enabled in object",
      input: { traces: true, metrics: true, logs: true },
      expected: { traces: true, metrics: true, logs: true },
    },
    {
      description:
        "should handle mixed configuration (traces and logs enabled)",
      input: { traces: true, metrics: false, logs: true },
      expected: { traces: true, metrics: false, logs: true },
    },
    {
      description: "should handle mixed configuration (only metrics enabled)",
      input: { traces: false, metrics: true, logs: false },
      expected: { traces: false, metrics: true, logs: false },
    },
  ])("$description", ({ input, expected }) => {
    const result = normalizeTelemetryOptions(input);
    expect(result).toEqual(expected);
  });
});

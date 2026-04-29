import { describe, expect, it } from "vitest";
import {
  formatMetricSourceErrors,
  validateMetricSource,
} from "./validate-metric-source";

describe("validateMetricSource", () => {
  it("accepts a valid SP-only configuration", () => {
    const result = validateMetricSource({
      sp: { revenue: { source: "demo.public.revenue" } },
    });
    expect(result.valid).toBe(true);
    expect(result.config).toBeDefined();
  });

  it("accepts an empty configuration", () => {
    expect(validateMetricSource({}).valid).toBe(true);
    expect(validateMetricSource({ sp: {}, obo: {} }).valid).toBe(true);
  });

  it("rejects null/non-object inputs", () => {
    expect(validateMetricSource(null).valid).toBe(false);
    expect(validateMetricSource(undefined).valid).toBe(false);
    expect(validateMetricSource("not an object").valid).toBe(false);
    expect(validateMetricSource([1, 2, 3]).valid).toBe(false);
  });

  it("rejects bare-string source entries (must be {source})", () => {
    const result = validateMetricSource({
      sp: { revenue: "demo.public.revenue" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects entries with unknown fields (closed v1 contract)", () => {
    const result = validateMetricSource({
      sp: { revenue: { source: "demo.public.revenue", cacheTtl: 60 } },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects metric keys starting with a digit", () => {
    const result = validateMetricSource({
      sp: { "1bad-key": { source: "demo.public.revenue" } },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects non-three-part FQNs", () => {
    const result = validateMetricSource({
      sp: { revenue: { source: "two.parts" } },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const result = validateMetricSource({
      sp: {},
      obo: {},
      extra: {},
    });
    expect(result.valid).toBe(false);
  });
});

describe("formatMetricSourceErrors", () => {
  it("formats a 'required' error with property name", () => {
    const result = validateMetricSource({
      sp: { revenue: {} },
    });
    expect(result.valid).toBe(false);
    const formatted = formatMetricSourceErrors(result.errors ?? []);
    expect(formatted).toContain('missing required property "source"');
  });

  it("formats an 'additionalProperties' error with property name", () => {
    const result = validateMetricSource({
      sp: { revenue: { source: "demo.public.revenue", cacheTtl: 60 } },
    });
    expect(result.valid).toBe(false);
    const formatted = formatMetricSourceErrors(result.errors ?? []);
    expect(formatted).toContain('unknown property "cacheTtl"');
  });

  it("formats a 'pattern' error", () => {
    const result = validateMetricSource({
      sp: { revenue: { source: "two.parts" } },
    });
    expect(result.valid).toBe(false);
    const formatted = formatMetricSourceErrors(result.errors ?? []);
    expect(formatted).toContain("does not match expected pattern");
  });

  it("produces a stable error message for a multi-issue input", () => {
    const result = validateMetricSource({
      sp: { revenue: {}, "1bad": { source: "two.parts" } },
    });
    expect(result.valid).toBe(false);
    expect(formatMetricSourceErrors(result.errors ?? [])).toMatchSnapshot();
  });
});

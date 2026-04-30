import { describe, expect, it } from "vitest";
import { compareSemver, validateCliCompat } from "./check-cli-compat";

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("compares major versions", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("compares minor versions", () => {
    expect(compareSemver("1.2.0", "1.1.0")).toBeGreaterThan(0);
    expect(compareSemver("1.1.0", "1.2.0")).toBeLessThan(0);
  });

  it("compares patch versions", () => {
    expect(compareSemver("1.0.2", "1.0.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.1", "1.0.2")).toBeLessThan(0);
  });

  it("handles large version numbers", () => {
    expect(compareSemver("0.299.0", "0.288.0")).toBeGreaterThan(0);
  });
});

describe("validateCliCompat", () => {
  const valid = {
    next: { appkit: "0.24.0", skills: "0.1.4" },
    "0.299.0": { appkit: "0.24.0", skills: "0.1.4" },
  };

  it("accepts a valid manifest", () => {
    expect(validateCliCompat(valid)).toEqual([]);
  });

  it("rejects non-object input", () => {
    expect(validateCliCompat(null)).toEqual([
      "cli-compat.json must be a JSON object",
    ]);
    expect(validateCliCompat([])).toEqual([
      "cli-compat.json must be a JSON object",
    ]);
    expect(validateCliCompat("string")).toEqual([
      "cli-compat.json must be a JSON object",
    ]);
  });

  it("rejects manifest without next key", () => {
    expect(validateCliCompat({ "0.299.0": valid["0.299.0"] })).toEqual([
      'cli-compat.json must contain a "next" key',
    ]);
  });

  it("rejects manifest with only next key", () => {
    expect(validateCliCompat({ next: valid.next })).toEqual([
      'cli-compat.json must contain at least one versioned CLI entry besides "next"',
    ]);
  });

  it("rejects invalid semver keys", () => {
    const errors = validateCliCompat({
      next: valid.next,
      "not-semver": { appkit: "0.1.0", skills: "0.1.0" },
    });
    expect(errors).toEqual([
      expect.stringContaining('Invalid key "not-semver"'),
    ]);
  });

  it("rejects non-object values", () => {
    const errors = validateCliCompat({
      next: valid.next,
      "1.0.0": "bad",
    });
    expect(errors).toEqual([
      expect.stringContaining('Value for "1.0.0" must be an object'),
    ]);
  });

  it("rejects invalid appkit semver", () => {
    const errors = validateCliCompat({
      next: { appkit: "bad", skills: "0.1.0" },
      "1.0.0": { appkit: "0.1.0", skills: "0.1.0" },
    });
    expect(errors).toEqual([
      expect.stringContaining('"next.appkit" must be a valid semver string'),
    ]);
  });

  it("rejects invalid skills semver", () => {
    const errors = validateCliCompat({
      next: { appkit: "0.1.0", skills: "not-valid" },
      "1.0.0": { appkit: "0.1.0", skills: "0.1.0" },
    });
    expect(errors).toEqual([
      expect.stringContaining('"next.skills" must be a valid semver string'),
    ]);
  });

  it("rejects missing appkit field", () => {
    const errors = validateCliCompat({
      next: { skills: "0.1.0" },
      "1.0.0": { appkit: "0.1.0", skills: "0.1.0" },
    });
    expect(errors).toEqual([
      expect.stringContaining('"next.appkit" must be a valid semver string'),
    ]);
  });

  it("rejects extra fields in entries", () => {
    const errors = validateCliCompat({
      next: { appkit: "0.24.0", skills: "0.1.4", extra: "bad" },
      "0.299.0": { appkit: "0.24.0", skills: "0.1.4" },
    });
    expect(errors).toEqual([
      expect.stringContaining('"next" has unexpected fields: extra'),
    ]);
  });

  it("rejects next.appkit lower than a versioned entry", () => {
    const errors = validateCliCompat({
      next: { appkit: "0.23.0", skills: "0.1.4" },
      "0.299.0": { appkit: "0.24.0", skills: "0.1.4" },
    });
    expect(errors).toEqual([
      expect.stringContaining(
        '"next.appkit" (0.23.0) must be >= "0.299.0.appkit" (0.24.0)',
      ),
    ]);
  });

  it("rejects next.skills lower than a versioned entry", () => {
    const errors = validateCliCompat({
      next: { appkit: "0.24.0", skills: "0.1.0" },
      "0.299.0": { appkit: "0.24.0", skills: "0.1.4" },
    });
    expect(errors).toEqual([
      expect.stringContaining(
        '"next.skills" (0.1.0) must be >= "0.299.0.skills" (0.1.4)',
      ),
    ]);
  });

  it("rejects non-monotonic versioned keys", () => {
    const errors = validateCliCompat({
      next: { appkit: "0.24.0", skills: "0.1.4" },
      "0.299.0": { appkit: "0.24.0", skills: "0.1.4" },
      "0.288.0": { appkit: "0.23.0", skills: "0.1.3" },
    });
    expect(errors).toEqual([expect.stringContaining("ascending semver order")]);
  });

  it("accepts multiple versioned entries in ascending order", () => {
    const errors = validateCliCompat({
      next: { appkit: "0.24.0", skills: "0.1.4" },
      "0.288.0": { appkit: "0.23.0", skills: "0.1.3" },
      "0.299.0": { appkit: "0.24.0", skills: "0.1.4" },
    });
    expect(errors).toEqual([]);
  });

  it("returns structure errors before cross-entry checks", () => {
    const errors = validateCliCompat({
      next: { appkit: "bad", skills: "0.1.0" },
      "1.0.0": { appkit: "0.2.0", skills: "0.2.0" },
    });
    // Should get the structure error but NOT a "next >= versioned" error
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"next.appkit" must be a valid semver string');
  });
});

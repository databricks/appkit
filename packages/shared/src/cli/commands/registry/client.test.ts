import { describe, expect, it } from "vitest";

import { isValidItemName, stripNamespace } from "./client";

describe("stripNamespace", () => {
  it("removes the @databricks-appkit/ prefix", () => {
    expect(stripNamespace("@databricks-appkit/metric-card")).toBe(
      "metric-card",
    );
  });

  it("leaves an un-namespaced ref unchanged", () => {
    expect(stripNamespace("hello")).toBe("hello");
  });
});

describe("isValidItemName", () => {
  it("accepts plain slugs", () => {
    expect(isValidItemName("metric-card")).toBe(true);
    expect(isValidItemName("hello")).toBe(true);
    expect(isValidItemName("a.b_c-1")).toBe(true);
  });

  it("rejects path separators, dot-segments, and control chars", () => {
    // path-traversal vectors from an untrusted registryDependency ref
    expect(isValidItemName("../../attacker/repo/payload")).toBe(false);
    expect(isValidItemName("a/b")).toBe(false);
    expect(isValidItemName("a\\b")).toBe(false);
    expect(isValidItemName(".")).toBe(false);
    expect(isValidItemName("..")).toBe(false);
    expect(isValidItemName("evil\x1b[31m")).toBe(false);
    expect(isValidItemName("has space")).toBe(false);
    expect(isValidItemName("")).toBe(false);
  });
});

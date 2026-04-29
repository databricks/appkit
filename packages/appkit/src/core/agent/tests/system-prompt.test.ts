import { describe, expect, test } from "vitest";
import { buildBaseSystemPrompt, composeSystemPrompt } from "../system-prompt";

describe("buildBaseSystemPrompt", () => {
  test("includes plugin names", () => {
    const prompt = buildBaseSystemPrompt(["analytics", "files", "genie"]);
    expect(prompt).toContain("Active plugins: analytics, files, genie");
  });

  test("includes guidelines", () => {
    const prompt = buildBaseSystemPrompt([]);
    expect(prompt).toContain("Guidelines:");
    expect(prompt).toContain("Databricks SQL");
    expect(prompt).toContain("summarize key findings");
  });

  test("works with no plugins", () => {
    const prompt = buildBaseSystemPrompt([]);
    expect(prompt).toContain("AI assistant running on Databricks AppKit");
    expect(prompt).not.toContain("Active plugins:");
  });

  test("does NOT include individual tool names", () => {
    const prompt = buildBaseSystemPrompt(["analytics"]);
    expect(prompt).not.toContain("analytics.query");
    expect(prompt).not.toContain("Available tools:");
  });
});

describe("composeSystemPrompt", () => {
  test("concatenates base + agent prompt with double newline", () => {
    const composed = composeSystemPrompt("Base prompt.", "Agent prompt.");
    expect(composed).toBe("Base prompt.\n\nAgent prompt.");
  });

  test("returns base prompt alone when no agent prompt", () => {
    const composed = composeSystemPrompt("Base prompt.");
    expect(composed).toBe("Base prompt.");
  });

  test("returns base prompt when agent prompt is empty string", () => {
    const composed = composeSystemPrompt("Base prompt.", "");
    expect(composed).toBe("Base prompt.");
  });
});

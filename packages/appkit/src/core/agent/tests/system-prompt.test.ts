import { describe, expect, test } from "vitest";
import { buildBaseSystemPrompt, composeSystemPrompt } from "../system-prompt";

const emptyCtx = {
  agentName: "a",
  pluginNames: [] as string[],
  toolNames: [] as string[],
};

describe("buildBaseSystemPrompt", () => {
  test("includes plugin names", () => {
    const prompt = buildBaseSystemPrompt({
      agentName: "assistant",
      pluginNames: ["analytics", "files", "genie"],
      toolNames: [],
    });
    expect(prompt).toContain("Active AppKit plugins: analytics, files, genie");
  });

  test("includes guidelines", () => {
    const prompt = buildBaseSystemPrompt(emptyCtx);
    expect(prompt).toContain("Guidelines:");
    expect(prompt).toContain("syntax, dialect, or path rules");
    expect(prompt).toContain("summarize what matters");
  });

  test("works with no plugins", () => {
    const prompt = buildBaseSystemPrompt(emptyCtx);
    expect(prompt).toContain("AI assistant running on Databricks AppKit");
    expect(prompt).not.toContain("Active AppKit plugins:");
  });

  test("does NOT include individual tool names", () => {
    const prompt = buildBaseSystemPrompt({
      agentName: "a",
      pluginNames: ["analytics"],
      toolNames: ["analytics.query"],
    });
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

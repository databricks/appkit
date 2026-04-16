import fs from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { loadAgentConfigs, parseFrontmatter } from "../config-loader";

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("parseFrontmatter", () => {
  test("parses frontmatter + body", () => {
    const result = parseFrontmatter(
      "---\nendpoint: my-model\nmaxSteps: 10\n---\nYou are helpful.",
    );
    expect(result.data).toEqual({ endpoint: "my-model", maxSteps: 10 });
    expect(result.content).toBe("You are helpful.");
  });

  test("returns full content when no frontmatter", () => {
    const result = parseFrontmatter("Just a plain prompt.");
    expect(result.data).toEqual({});
    expect(result.content).toBe("Just a plain prompt.");
  });

  test("parses boolean values", () => {
    const result = parseFrontmatter("---\ndefault: true\n---\nPrompt.");
    expect(result.data.default).toBe(true);
  });

  test("parses numeric values", () => {
    const result = parseFrontmatter(
      "---\nmaxSteps: 5\nmaxTokens: 2048\n---\nPrompt.",
    );
    expect(result.data.maxSteps).toBe(5);
    expect(result.data.maxTokens).toBe(2048);
  });

  test("handles empty body", () => {
    const result = parseFrontmatter("---\nendpoint: model\n---\n");
    expect(result.data.endpoint).toBe("model");
    expect(result.content).toBe("");
  });

  test("handles colons in values", () => {
    const result = parseFrontmatter(
      "---\nendpoint: https://host:443/path\n---\nPrompt.",
    );
    expect(result.data.endpoint).toBe("https://host:443/path");
  });
});

describe("loadAgentConfigs", () => {
  test("returns empty array for non-existent directory", () => {
    const result = loadAgentConfigs("/nonexistent/path");
    expect(result).toEqual([]);
  });

  test("parses .md files from directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-"));

    try {
      fs.writeFileSync(
        path.join(tmpDir, "assistant.md"),
        "---\nendpoint: claude\ndefault: true\n---\nYou are helpful.",
      );
      fs.writeFileSync(
        path.join(tmpDir, "autocomplete.md"),
        "---\nendpoint: gemini\nmaxSteps: 1\n---\nJust continue.",
      );

      const configs = loadAgentConfigs(tmpDir);

      expect(configs).toHaveLength(2);

      const assistant = configs.find((c) => c.name === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant?.endpoint).toBe("claude");
      expect(assistant?.default).toBe(true);
      expect(assistant?.systemPrompt).toBe("You are helpful.");

      const autocomplete = configs.find((c) => c.name === "autocomplete");
      expect(autocomplete).toBeDefined();
      expect(autocomplete?.endpoint).toBe("gemini");
      expect(autocomplete?.maxSteps).toBe(1);
      expect(autocomplete?.systemPrompt).toBe("Just continue.");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("handles file with no frontmatter", () => {
    const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-"));

    try {
      fs.writeFileSync(
        path.join(tmpDir, "simple.md"),
        "Just a plain system prompt.",
      );

      const configs = loadAgentConfigs(tmpDir);
      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe("simple");
      expect(configs[0].endpoint).toBeUndefined();
      expect(configs[0].systemPrompt).toBe("Just a plain system prompt.");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("ignores non-.md files", () => {
    const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-"));

    try {
      fs.writeFileSync(path.join(tmpDir, "agent.md"), "Prompt.");
      fs.writeFileSync(path.join(tmpDir, "config.yaml"), "key: value");
      fs.writeFileSync(path.join(tmpDir, "notes.txt"), "Notes.");

      const configs = loadAgentConfigs(tmpDir);
      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe("agent");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

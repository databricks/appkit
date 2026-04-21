import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { buildToolkitEntries } from "../build-toolkit";
import {
  loadAgentFromFile,
  loadAgentsFromDir,
  parseFrontmatter,
} from "../load-agents";
import { defineTool, type ToolRegistry } from "../tools/define-tool";
import { tool } from "../tools/tool";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function write(name: string, content: string) {
  fs.writeFileSync(path.join(workDir, name), content, "utf-8");
  return path.join(workDir, name);
}

describe("parseFrontmatter", () => {
  test("parses a simple object", () => {
    const { data, content } = parseFrontmatter(
      "---\nendpoint: foo\ndefault: true\n---\nHello body",
    );
    expect(data).toEqual({ endpoint: "foo", default: true });
    expect(content).toBe("Hello body");
  });

  test("parses nested arrays", () => {
    const { data } = parseFrontmatter(
      "---\ntoolkits:\n  - analytics\n  - files: [uploads.list]\n---\nbody",
    );
    expect(data?.toolkits).toEqual(["analytics", { files: ["uploads.list"] }]);
  });

  test("returns null data when no frontmatter", () => {
    const { data, content } = parseFrontmatter("No frontmatter here");
    expect(data).toBeNull();
    expect(content).toBe("No frontmatter here");
  });

  test("throws on invalid YAML", () => {
    expect(() => parseFrontmatter("---\nkey: : : bad\n---\n")).toThrow(/YAML/);
  });
});

describe("loadAgentFromFile", () => {
  test("returns AgentDefinition with body as instructions", async () => {
    const p = write(
      "assistant.md",
      "---\nendpoint: e-1\n---\nYou are helpful.",
    );
    const def = await loadAgentFromFile(p, {});
    expect(def.name).toBe("assistant");
    expect(def.instructions).toBe("You are helpful.");
    expect(def.model).toBe("e-1");
  });
});

describe("loadAgentsFromDir", () => {
  test("returns empty map when dir doesn't exist", async () => {
    const res = await loadAgentsFromDir("/nonexistent-for-tests", {});
    expect(res.defs).toEqual({});
    expect(res.defaultAgent).toBeNull();
  });

  test("loads all .md files keyed by file-stem", async () => {
    write("support.md", "---\nendpoint: e-1\n---\nSupport prompt.");
    write("sales.md", "---\nendpoint: e-2\n---\nSales prompt.");
    const res = await loadAgentsFromDir(workDir, {});
    expect(Object.keys(res.defs).sort()).toEqual(["sales", "support"]);
  });

  test("picks up default: true from frontmatter", async () => {
    write("one.md", "---\nendpoint: a\n---\nOne.");
    write("two.md", "---\nendpoint: b\ndefault: true\n---\nTwo.");
    const res = await loadAgentsFromDir(workDir, {});
    expect(res.defaultAgent).toBe("two");
  });

  test("throws when frontmatter references an unregistered plugin", async () => {
    write(
      "broken.md",
      "---\nendpoint: e\ntoolkits: [missing]\n---\nBroken agent.",
    );
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /references toolkit 'missing'/,
    );
  });

  test("throws when frontmatter references an unknown ambient tool", async () => {
    write("broken.md", "---\nendpoint: e\ntools: [unknown_tool]\n---\nBroken.");
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /references tool 'unknown_tool'/,
    );
  });

  test("resolves toolkits + ambient tools when provided", async () => {
    const registry: ToolRegistry = {
      query: defineTool({
        description: "q",
        schema: z.object({ sql: z.string() }),
        handler: () => "ok",
      }),
    };
    const plugins = new Map<
      string,
      { toolkit: (opts?: unknown) => Record<string, unknown> }
    >([
      [
        "analytics",
        {
          toolkit: (opts) =>
            buildToolkitEntries("analytics", registry, opts as never),
        },
      ],
    ]);

    const weather = tool({
      name: "get_weather",
      description: "Weather",
      schema: z.object({ city: z.string() }),
      execute: async () => "sunny",
    });

    write(
      "analyst.md",
      "---\nendpoint: e\ntoolkits:\n  - analytics\ntools:\n  - get_weather\n---\nBody.",
    );
    const res = await loadAgentsFromDir(workDir, {
      plugins,
      availableTools: { get_weather: weather },
    });
    expect(res.defs.analyst.tools).toBeDefined();
    expect(Object.keys(res.defs.analyst.tools ?? {}).sort()).toEqual([
      "analytics.query",
      "get_weather",
    ]);
  });
});

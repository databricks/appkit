import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { buildToolkitEntries } from "../../../core/agent/build-toolkit";
import {
  defineTool,
  type ToolRegistry,
} from "../../../core/agent/tools/define-tool";
import { tool } from "../../../core/agent/tools/tool";
import type { AgentDefinition } from "../../../core/agent/types";
import {
  agentIdFromMarkdownPath,
  loadAgentFromFile,
  loadAgentsFromDir,
  parseFrontmatter,
} from "../load-agents";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Flat file under workDir (for legacy loadAgentFromFile tests). */
function writeRoot(name: string, content: string) {
  fs.writeFileSync(path.join(workDir, name), content, "utf-8");
  return path.join(workDir, name);
}

/** Folder layout: `<id>/agent.md`. */
function writeAgent(id: string, content: string) {
  const dir = path.join(workDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "agent.md");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("agentIdFromMarkdownPath", () => {
  test("uses parent folder name when file is agent.md", () => {
    expect(agentIdFromMarkdownPath("/foo/bar/assistant/agent.md")).toBe(
      "assistant",
    );
  });

  test("uses file stem for other .md names", () => {
    expect(agentIdFromMarkdownPath("/tmp/assistant.md")).toBe("assistant");
  });
});

describe("parseFrontmatter", () => {
  test("parses a simple object", () => {
    const { data, content } = parseFrontmatter(
      "---\nendpoint: foo\ndefault: true\n---\nHello body",
    );
    expect(data).toEqual({ endpoint: "foo", default: true });
    expect(content).toBe("Hello body");
  });

  test("parses nested arrays in unified tools list", () => {
    const { data } = parseFrontmatter(
      "---\ntools:\n  - plugin:analytics\n  - plugin:files: [uploads.list]\n  - get_weather\n---\nbody",
    );
    expect(data?.tools).toEqual([
      "plugin:analytics",
      { "plugin:files": ["uploads.list"] },
      "get_weather",
    ]);
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
    const p = writeRoot(
      "assistant.md",
      "---\nendpoint: e-1\n---\nYou are helpful.",
    );
    const def = await loadAgentFromFile(p, {});
    expect(def.name).toBe("assistant");
    expect(def.instructions).toBe("You are helpful.");
    expect(def.model).toBe("e-1");
  });

  test("derives agent id from folder when path ends with agent.md", async () => {
    const p = writeAgent("router", "---\nendpoint: e-1\n---\nRoute traffic.");
    const def = await loadAgentFromFile(p, {});
    expect(def.name).toBe("router");
    expect(def.instructions).toBe("Route traffic.");
  });
});

describe("loadAgentsFromDir", () => {
  test("returns empty map when dir doesn't exist", async () => {
    const res = await loadAgentsFromDir("/nonexistent-for-tests", {});
    expect(res.defs).toEqual({});
    expect(res.defaultAgent).toBeNull();
  });

  test("loads each subdirectory with agent.md keyed by folder name", async () => {
    writeAgent("support", "---\nendpoint: e-1\n---\nSupport prompt.");
    writeAgent("sales", "---\nendpoint: e-2\n---\nSales prompt.");
    const res = await loadAgentsFromDir(workDir, {});
    expect(Object.keys(res.defs).sort()).toEqual(["sales", "support"]);
  });

  test("throws when legacy top-level .md exists", async () => {
    writeRoot("assistant.md", "---\nendpoint: e\n---\nLegacy flat file.");
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /unsupported top-level markdown file\(s\): assistant\.md.*assistant\/agent\.md/s,
    );
  });

  test("throws when a subdirectory lacks agent.md", async () => {
    fs.mkdirSync(path.join(workDir, "broken"), { recursive: true });
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /must contain agent\.md/,
    );
  });

  test("ignores reserved skills directory without agent.md", async () => {
    fs.mkdirSync(path.join(workDir, "skills"), { recursive: true });
    writeAgent("solo", "---\nendpoint: e\n---\nOnly real agent.");
    const res = await loadAgentsFromDir(workDir, {});
    expect(Object.keys(res.defs)).toEqual(["solo"]);
  });

  test("picks up default: true from frontmatter (deterministic sorted ids)", async () => {
    writeAgent("one", "---\nendpoint: a\n---\nOne.");
    writeAgent("two", "---\nendpoint: b\ndefault: true\n---\nTwo.");
    const res = await loadAgentsFromDir(workDir, {});
    expect(res.defaultAgent).toBe("two");
  });

  test("throws when frontmatter references an unregistered plugin", async () => {
    writeAgent(
      "broken",
      "---\nendpoint: e\ntools:\n  - plugin:missing\n---\nBroken agent.",
    );
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /references 'plugin:missing'/,
    );
  });

  test("throws when frontmatter references an unknown ambient tool", async () => {
    writeAgent(
      "broken",
      "---\nendpoint: e\ntools:\n  - unknown_tool\n---\nBroken.",
    );
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /references ambient tool 'unknown_tool'/,
    );
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(/plugin:NAME/);
  });

  test("resolves a mix of plugin and ambient tools in the unified list", async () => {
    const registry: ToolRegistry = {
      query: defineTool({
        description: "q",
        schema: z.object({ sql: z.string() }),
        execute: () => "ok",
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

    writeAgent(
      "analyst",
      "---\nendpoint: e\ntools:\n  - plugin:analytics\n  - get_weather\n---\nBody.",
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

  test("plugin:NAME with an array filters via { only }", async () => {
    const registry: ToolRegistry = {
      list: defineTool({
        description: "l",
        schema: z.object({}),
        execute: () => [],
      }),
      read: defineTool({
        description: "r",
        schema: z.object({ path: z.string() }),
        execute: () => "x",
      }),
      delete: defineTool({
        description: "d",
        schema: z.object({ path: z.string() }),
        execute: () => undefined,
      }),
    };
    const plugins = new Map<
      string,
      { toolkit: (opts?: unknown) => Record<string, unknown> }
    >([
      [
        "files",
        {
          toolkit: (opts) =>
            buildToolkitEntries("files", registry, opts as never),
        },
      ],
    ]);

    writeAgent(
      "reader",
      "---\nendpoint: e\ntools:\n  - plugin:files: [list, read]\n---\nReader.",
    );
    const res = await loadAgentsFromDir(workDir, { plugins });
    expect(Object.keys(res.defs.reader.tools ?? {}).sort()).toEqual([
      "files.list",
      "files.read",
    ]);
  });

  test("plugin:NAME with a full ToolkitOptions object honours prefix/rename", async () => {
    const registry: ToolRegistry = {
      query: defineTool({
        description: "q",
        schema: z.object({ sql: z.string() }),
        execute: () => "ok",
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

    writeAgent(
      "renamer",
      `---\nendpoint: e\ntools:\n  - plugin:analytics: { prefix: "", rename: { query: sql_query } }\n---\nBody.`,
    );
    const res = await loadAgentsFromDir(workDir, { plugins });
    expect(Object.keys(res.defs.renamer.tools ?? {})).toEqual(["sql_query"]);
  });

  test("rejects an object entry whose key isn't 'plugin:NAME'", async () => {
    writeAgent("bad", "---\nendpoint: e\ntools:\n  - files: [a]\n---\nBad.");
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /reserved for plugin references/,
    );
  });

  test("rejects empty 'plugin:' (no plugin name after the prefix)", async () => {
    writeAgent("bad", "---\nendpoint: e\ntools:\n  - plugin:\n---\nBad.");
    await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
      /empty plugin name/,
    );
  });

  describe("agents: sibling sub-agent references", () => {
    test("resolves sibling references into def.agents regardless of folder order", async () => {
      writeAgent(
        "dispatcher",
        "---\nendpoint: e\nagents:\n  - analyst\n  - writer\n---\nRoute work.",
      );
      writeAgent("analyst", "---\nendpoint: e\n---\nAnalyst.");
      writeAgent("writer", "---\nendpoint: e\n---\nWriter.");

      const res = await loadAgentsFromDir(workDir, {});
      expect(Object.keys(res.defs.dispatcher.agents ?? {}).sort()).toEqual([
        "analyst",
        "writer",
      ]);
      expect(res.defs.dispatcher.agents?.analyst).toBe(res.defs.analyst);
      expect(res.defs.dispatcher.agents?.writer).toBe(res.defs.writer);
      expect(res.defs.analyst.agents).toBeUndefined();
      expect(res.defs.writer.agents).toBeUndefined();
    });

    test("mutual delegation is allowed (runtime depth cap handles cycles)", async () => {
      writeAgent("a", "---\nendpoint: e\nagents:\n  - b\n---\nA.");
      writeAgent("b", "---\nendpoint: e\nagents:\n  - a\n---\nB.");

      const res = await loadAgentsFromDir(workDir, {});
      expect(res.defs.a.agents?.b).toBe(res.defs.b);
      expect(res.defs.b.agents?.a).toBe(res.defs.a);
    });

    test("throws with available list when a sibling is missing", async () => {
      writeAgent("dispatcher", "---\nendpoint: e\nagents:\n  - ghost\n---\nD.");
      writeAgent("analyst", "---\nendpoint: e\n---\nAnalyst.");
      await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
        /references sub-agent\(s\) 'ghost'.*Available: analyst, dispatcher/s,
      );
    });

    test("reports every missing sibling in one error, not just the first", async () => {
      writeAgent(
        "dispatcher",
        "---\nendpoint: e\nagents:\n  - ghost1\n  - ghost2\n---\nD.",
      );
      await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
        /ghost1, ghost2/,
      );
    });

    test("throws on self-reference", async () => {
      writeAgent("solo", "---\nendpoint: e\nagents:\n  - solo\n---\nSolo.");
      await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
        /'solo'.*cannot reference itself/s,
      );
    });

    test("throws on non-array 'agents:' value", async () => {
      writeAgent("bad", "---\nendpoint: e\nagents: analyst\n---\nBad.");
      writeAgent("analyst", "---\nendpoint: e\n---\nAnalyst.");
      await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
        /invalid 'agents:' frontmatter/,
      );
    });

    test("throws on non-string entries in 'agents:'", async () => {
      writeAgent("bad", "---\nendpoint: e\nagents:\n  - 42\n---\nBad.");
      await expect(loadAgentsFromDir(workDir, {})).rejects.toThrow(
        /invalid 'agents:' entry/,
      );
    });

    test("deduplicates repeated entries silently", async () => {
      writeAgent(
        "dispatcher",
        "---\nendpoint: e\nagents:\n  - analyst\n  - analyst\n---\nD.",
      );
      writeAgent("analyst", "---\nendpoint: e\n---\nAnalyst.");
      const res = await loadAgentsFromDir(workDir, {});
      expect(Object.keys(res.defs.dispatcher.agents ?? {})).toEqual([
        "analyst",
      ]);
    });

    test("empty array yields no sub-agents (no-op)", async () => {
      writeAgent("dispatcher", "---\nendpoint: e\nagents: []\n---\nD.");
      const res = await loadAgentsFromDir(workDir, {});
      expect(res.defs.dispatcher.agents).toBeUndefined();
    });

    test("resolves 'agents:' references against codeAgents when provided", async () => {
      writeAgent(
        "dispatcher",
        "---\nendpoint: e\nagents:\n  - support\n---\nD.",
      );
      const support: AgentDefinition = {
        name: "support",
        instructions: "Code-defined support.",
      };
      const res = await loadAgentsFromDir(workDir, {
        codeAgents: { support },
      });
      expect(res.defs.dispatcher.agents?.support).toBe(support);
    });

    test("codeAgents takes precedence over markdown sibling with the same name", async () => {
      writeAgent(
        "dispatcher",
        "---\nendpoint: e\nagents:\n  - support\n---\nD.",
      );
      writeAgent("support", "---\nendpoint: e\n---\nMarkdown support.");
      const codeSupport: AgentDefinition = {
        name: "support",
        instructions: "Code support.",
      };
      const res = await loadAgentsFromDir(workDir, {
        codeAgents: { support: codeSupport },
      });
      expect(res.defs.dispatcher.agents?.support).toBe(codeSupport);
      expect(res.defs.dispatcher.agents?.support.instructions).toBe(
        "Code support.",
      );
    });

    test("missing-sibling error lists both markdown and code agent names", async () => {
      writeAgent("dispatcher", "---\nendpoint: e\nagents:\n  - ghost\n---\nD.");
      writeAgent("analyst", "---\nendpoint: e\n---\nAnalyst.");
      const codeAgent: AgentDefinition = {
        name: "writer",
        instructions: "Writer.",
      };
      await expect(
        loadAgentsFromDir(workDir, { codeAgents: { writer: codeAgent } }),
      ).rejects.toThrow(/Available: analyst, dispatcher, writer/);
    });
  });
});

describe("loadAgentFromFile — sub-agent refs rejected", () => {
  test("throws when 'agents:' is non-empty in a single-file load", async () => {
    const p = writeRoot(
      "lonely.md",
      "---\nendpoint: e\nagents:\n  - ghost\n---\nLonely.",
    );
    await expect(loadAgentFromFile(p, {})).rejects.toThrow(
      /requires loadAgentsFromDir/,
    );
  });

  test("ignores empty 'agents:' array (treated as absent)", async () => {
    const p = writeRoot(
      "lonely.md",
      "---\nendpoint: e\nagents: []\n---\nLonely.",
    );
    const def = await loadAgentFromFile(p, {});
    expect(def.agents).toBeUndefined();
  });
});

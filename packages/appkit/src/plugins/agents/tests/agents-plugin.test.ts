import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
  ToolProvider,
} from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { CacheManager } from "../../../cache";
// Import the class directly so we can construct it without a createApp
import { AgentsPlugin } from "../agents";
import { buildToolkitEntries } from "../build-toolkit";
import { fromPlugin } from "../from-plugin";
import { defineTool, type ToolRegistry } from "../tools/define-tool";
import { tool } from "../tools/tool";
import type { AgentsPluginConfig, ToolkitEntry } from "../types";
import { isToolkitEntry } from "../types";

function namedFactory(name: string) {
  const f = () => ({ name });
  Object.defineProperty(f, "pluginName", { value: name, enumerable: true });
  return f as typeof f & { readonly pluginName: string };
}

interface FakeContext {
  providers: Array<{ name: string; provider: ToolProvider }>;
  getToolProviders(): Array<{ name: string; provider: ToolProvider }>;
  getPluginNames(): string[];
  addRoute(): void;
  executeTool: (
    req: unknown,
    pluginName: string,
    localName: string,
    args: unknown,
  ) => Promise<unknown>;
}

function fakeContext(
  providers: Array<{ name: string; provider: ToolProvider }>,
): FakeContext {
  return {
    providers,
    getToolProviders: () => providers,
    getPluginNames: () => providers.map((p) => p.name),
    addRoute: vi.fn(),
    executeTool: vi.fn(async (_req, p, n, args) => ({
      plugin: p,
      tool: n,
      args,
    })),
  };
}

function stubAdapter(): AgentAdapter {
  return {
    async *run(_input: AgentInput, _ctx: AgentRunContext) {
      yield { type: "message_delta", content: "" };
    },
  };
}

function makeToolProvider(
  pluginName: string,
  registry: ToolRegistry,
): ToolProvider & {
  toolkit: (opts?: unknown) => Record<string, ToolkitEntry>;
} {
  return {
    getAgentTools(): AgentToolDefinition[] {
      return Object.entries(registry).map(([name, entry]) => ({
        name,
        description: entry.description,
        parameters: { type: "object", properties: {} },
      }));
    },
    async executeAgentTool(name, args) {
      return { callFrom: pluginName, name, args };
    },
    toolkit: (opts) => buildToolkitEntries(pluginName, registry, opts as never),
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-plugin-"));
  const storage = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    keys: vi.fn(),
    healthCheck: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test-only CacheManager wiring
  await CacheManager.getInstance({ storage: storage as any });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function instantiate(config: AgentsPluginConfig, ctx?: FakeContext) {
  const plugin = new AgentsPlugin({ ...config, name: "agent" });
  plugin.attachContext({ context: ctx as unknown as object });
  return plugin;
}

describe("AgentsPlugin", () => {
  test("registers code-defined agents and exposes them via exports", async () => {
    const plugin = instantiate({
      dir: false,
      agents: {
        support: {
          instructions: "You help customers.",
          model: stubAdapter(),
        },
      },
    });
    await plugin.setup();

    const api = plugin.exports() as {
      list: () => string[];
      getDefault: () => string | null;
    };
    expect(api.list()).toEqual(["support"]);
    expect(api.getDefault()).toBe("support");
  });

  test("loads markdown agents from a directory", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "assistant.md"),
      "---\ndefault: true\n---\nYou are helpful.",
      "utf-8",
    );
    const plugin = instantiate({
      dir: tmpDir,
      defaultModel: stubAdapter(),
    });
    await plugin.setup();

    const api = plugin.exports() as {
      list: () => string[];
      getDefault: () => string | null;
    };
    expect(api.list()).toEqual(["assistant"]);
    expect(api.getDefault()).toBe("assistant");
  });

  test("code definitions override markdown on key collision", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "support.md"),
      "---\n---\nFrom markdown.",
      "utf-8",
    );
    const plugin = instantiate({
      dir: tmpDir,
      defaultModel: stubAdapter(),
      agents: {
        support: {
          instructions: "From code",
          model: stubAdapter(),
        },
      },
    });
    await plugin.setup();

    const api = plugin.exports() as {
      get: (name: string) => { instructions: string } | null;
    };
    expect(api.get("support")?.instructions).toBe("From code");
  });

  test("auto-inherit default is asymmetric (file yes, code no)", async () => {
    const registry: ToolRegistry = {
      query: defineTool({
        description: "q",
        schema: z.object({ sql: z.string() }),
        handler: () => "ok",
      }),
    };
    const provider = makeToolProvider("analytics", registry);
    const ctx = fakeContext([{ name: "analytics", provider }]);

    fs.writeFileSync(
      path.join(tmpDir, "assistant.md"),
      "---\n---\nYou are helpful.",
      "utf-8",
    );

    const plugin = instantiate(
      {
        dir: tmpDir,
        defaultModel: stubAdapter(),
        agents: {
          manual: {
            instructions: "Manual agent",
            model: stubAdapter(),
          },
        },
      },
      ctx,
    );
    await plugin.setup();

    const api = plugin.exports() as {
      get: (name: string) => { toolIndex: Map<string, unknown> } | null;
    };
    const fileAgent = api.get("assistant");
    const codeAgent = api.get("manual");

    expect(fileAgent?.toolIndex.size).toBeGreaterThan(0); // inherited analytics.query
    expect(codeAgent?.toolIndex.size).toBe(0); // code opted out by default
  });

  test("file-loaded agent respects explicit toolkits (skips auto-inherit)", async () => {
    const registry: ToolRegistry = {
      query: defineTool({
        description: "q",
        schema: z.object({ sql: z.string() }),
        handler: () => "ok",
      }),
    };
    const registry2: ToolRegistry = {
      list: defineTool({
        description: "l",
        schema: z.object({}),
        handler: () => [],
      }),
    };
    const ctx = fakeContext([
      { name: "analytics", provider: makeToolProvider("analytics", registry) },
      { name: "files", provider: makeToolProvider("files", registry2) },
    ]);

    fs.writeFileSync(
      path.join(tmpDir, "analyst.md"),
      "---\ntoolkits: [analytics]\n---\nAnalyst.",
      "utf-8",
    );

    const plugin = instantiate(
      { dir: tmpDir, defaultModel: stubAdapter() },
      ctx,
    );
    await plugin.setup();

    const api = plugin.exports() as {
      get: (name: string) => { toolIndex: Map<string, unknown> } | null;
    };
    const agent = api.get("analyst");
    const toolNames = Array.from(agent?.toolIndex.keys() ?? []);
    expect(toolNames.some((n) => n.startsWith("analytics."))).toBe(true);
    expect(toolNames.some((n) => n.startsWith("files."))).toBe(false);
  });

  test("registers sub-agents as agent-<key> tools", async () => {
    const plugin = instantiate({
      dir: false,
      agents: {
        supervisor: {
          instructions: "Supervise",
          model: stubAdapter(),
          agents: {
            worker: {
              instructions: "Work",
              model: stubAdapter(),
            },
          },
        },
      },
    });
    await plugin.setup();

    const api = plugin.exports() as {
      get: (name: string) => { toolIndex: Map<string, unknown> } | null;
    };
    const sup = api.get("supervisor");
    expect(sup?.toolIndex.has("agent-worker")).toBe(true);
  });

  test("isToolkitEntry type guard recognizes toolkit entries", () => {
    const entry: ToolkitEntry = {
      __toolkitRef: true,
      pluginName: "x",
      localName: "y",
      def: { name: "x.y", description: "", parameters: { type: "object" } },
    };
    expect(isToolkitEntry(entry)).toBe(true);
    expect(isToolkitEntry({ foo: 1 })).toBe(false);
    expect(isToolkitEntry(null)).toBe(false);
  });

  describe("fromPlugin markers", () => {
    test("spreading fromPlugin registers all tools from the referenced plugin", async () => {
      const registry: ToolRegistry = {
        query: defineTool({
          description: "q",
          schema: z.object({ sql: z.string() }),
          handler: () => "ok",
        }),
      };
      const ctx = fakeContext([
        {
          name: "analytics",
          provider: makeToolProvider("analytics", registry),
        },
      ]);

      const plugin = instantiate(
        {
          dir: false,
          agents: {
            support: {
              instructions: "...",
              model: stubAdapter(),
              tools: { ...fromPlugin(namedFactory("analytics")) },
            },
          },
        },
        ctx,
      );
      await plugin.setup();

      const api = plugin.exports() as {
        get: (name: string) => { toolIndex: Map<string, unknown> } | null;
      };
      const agent = api.get("support");
      expect(agent?.toolIndex.has("analytics.query")).toBe(true);
    });

    test("mixed inline + fromPlugin tools coexist", async () => {
      const registry: ToolRegistry = {
        query: defineTool({
          description: "q",
          schema: z.object({ sql: z.string() }),
          handler: () => "ok",
        }),
      };
      const ctx = fakeContext([
        {
          name: "analytics",
          provider: makeToolProvider("analytics", registry),
        },
      ]);

      const plugin = instantiate(
        {
          dir: false,
          agents: {
            support: {
              instructions: "...",
              model: stubAdapter(),
              tools: {
                ...fromPlugin(namedFactory("analytics")),
                get_weather: tool({
                  name: "get_weather",
                  description: "Weather",
                  schema: z.object({ city: z.string() }),
                  execute: async ({ city }) => `Sunny in ${city}`,
                }),
              },
            },
          },
        },
        ctx,
      );
      await plugin.setup();

      const api = plugin.exports() as {
        get: (name: string) => { toolIndex: Map<string, unknown> } | null;
      };
      const agent = api.get("support");
      expect(agent?.toolIndex.has("analytics.query")).toBe(true);
      expect(agent?.toolIndex.has("get_weather")).toBe(true);
    });

    test("missing plugin throws at setup with Available: listing", async () => {
      const ctx = fakeContext([
        {
          name: "files",
          provider: makeToolProvider("files", {}),
        },
      ]);

      const plugin = instantiate(
        {
          dir: false,
          agents: {
            support: {
              instructions: "...",
              model: stubAdapter(),
              tools: { ...fromPlugin(namedFactory("analytics")) },
            },
          },
        },
        ctx,
      );
      await expect(plugin.setup()).rejects.toThrow(/analytics/);
      await expect(plugin.setup()).rejects.toThrow(/Available:/);
      await expect(plugin.setup()).rejects.toThrow(/files/);
    });

    test("symbol-only tools record disables auto-inherit", async () => {
      const analyticsReg: ToolRegistry = {
        query: defineTool({
          description: "q",
          schema: z.object({ sql: z.string() }),
          handler: () => "ok",
        }),
      };
      const filesReg: ToolRegistry = {
        list: defineTool({
          description: "l",
          schema: z.object({}),
          handler: () => [],
        }),
      };
      const ctx = fakeContext([
        {
          name: "analytics",
          provider: makeToolProvider("analytics", analyticsReg),
        },
        {
          name: "files",
          provider: makeToolProvider("files", filesReg),
        },
      ]);

      const plugin = instantiate(
        {
          dir: false,
          autoInheritTools: { code: true },
          agents: {
            support: {
              instructions: "...",
              model: stubAdapter(),
              tools: { ...fromPlugin(namedFactory("analytics")) },
            },
          },
        },
        ctx,
      );
      await plugin.setup();

      const api = plugin.exports() as {
        get: (name: string) => { toolIndex: Map<string, unknown> } | null;
      };
      const agent = api.get("support");
      const toolNames = Array.from(agent?.toolIndex.keys() ?? []);
      expect(toolNames.some((n) => n.startsWith("analytics."))).toBe(true);
      expect(toolNames.some((n) => n.startsWith("files."))).toBe(false);
    });

    test("falls back to getAgentTools() for providers without toolkit()", async () => {
      // Provider lacks .toolkit() — only getAgentTools/executeAgentTool.
      const bareProvider: ToolProvider = {
        getAgentTools: () => [
          {
            name: "ping",
            description: "ping",
            parameters: { type: "object", properties: {} },
          },
        ],
        executeAgentTool: vi.fn(async () => "pong"),
      };
      const ctx = fakeContext([{ name: "bare", provider: bareProvider }]);

      const plugin = instantiate(
        {
          dir: false,
          agents: {
            support: {
              instructions: "...",
              model: stubAdapter(),
              tools: { ...fromPlugin(namedFactory("bare")) },
            },
          },
        },
        ctx,
      );
      await plugin.setup();

      const api = plugin.exports() as {
        get: (name: string) => { toolIndex: Map<string, unknown> } | null;
      };
      const agent = api.get("support");
      expect(agent?.toolIndex.has("bare.ping")).toBe(true);
    });
  });
});

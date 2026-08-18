import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentAdapter, AgentInput, AgentRunContext } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../../cache";
import type { AgentsPluginConfig } from "../../../core/agent/types";
import { AgentsPlugin } from "../agents";

/** Absolute path to a committed agent fixture directory. */
const fixtureDir = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function stubAdapter(): AgentAdapter {
  return {
    async *run(_input: AgentInput, _ctx: AgentRunContext) {
      yield { type: "message_delta", content: "" };
    },
  };
}

beforeEach(async () => {
  // Agent setup reads the cache singleton; initialize it with defaults.
  await CacheManager.getInstance();
});

function instantiate(config: AgentsPluginConfig) {
  const plugin = new AgentsPlugin({ ...config, name: "agent" });
  plugin.attachContext({ context: undefined as unknown as object });
  return plugin;
}

type ExportsApi = {
  list: () => string[];
  get: (name: string) => { toolIndex: Map<string, unknown> } | null;
  getDefault: () => string | null;
};

describe("AgentsPlugin agent discovery", () => {
  test("discovers code agents from the dir with no map at the call site", async () => {
    const plugin = instantiate({
      dir: fixtureDir("code-agents"),
      defaultModel: stubAdapter(),
    });
    await plugin.setup();

    const api = plugin.exports() as ExportsApi;
    // notAnAgent/ exports no created agent and is skipped.
    expect(api.list().sort()).toEqual(["builder", "helper"]);
    expect(api.getDefault()).toBe("builder");
  });

  test("honors default: true on a discovered code agent", async () => {
    const plugin = instantiate({
      dir: fixtureDir("code-agents-default"),
      defaultModel: stubAdapter(),
    });
    await plugin.setup();
    expect((plugin.exports() as ExportsApi).getDefault()).toBe("beta");
  });

  test("a discovered code default: true beats a markdown default: true", async () => {
    // code-agents-default holds beta (code, default:true) + planner (markdown,
    // default:true) side by side; code wins.
    const plugin = instantiate({
      dir: fixtureDir("code-agents-default"),
      defaultModel: stubAdapter(),
    });
    await plugin.setup();
    expect((plugin.exports() as ExportsApi).getDefault()).toBe("beta");
  });

  test("explicit defaultAgent overrides a discovered default: true", async () => {
    const plugin = instantiate({
      dir: fixtureDir("code-agents-default"),
      defaultAgent: "alpha",
      defaultModel: stubAdapter(),
    });
    await plugin.setup();
    expect((plugin.exports() as ExportsApi).getDefault()).toBe("alpha");
  });

  test("a markdown parent can delegate to a code sub-agent in a sibling folder", async () => {
    const plugin = instantiate({
      dir: fixtureDir("md-parent-code-child"),
      defaultModel: stubAdapter(),
    });
    await plugin.setup();

    const api = plugin.exports() as ExportsApi;
    expect(api.list().sort()).toEqual(["helper", "planner"]);
    expect(api.get("planner")?.toolIndex.has("agent-helper")).toBe(true);
    expect(api.getDefault()).toBe("planner");
  });

  test("discovery wins over a colliding deprecated-map entry (warns, no throw)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = instantiate({
      dir: fixtureDir("code-agents"),
      agents: {
        helper: { instructions: "from the map", model: stubAdapter() },
      },
      defaultModel: stubAdapter(),
    });
    await plugin.setup();

    const api = plugin.exports() as ExportsApi;
    expect(api.list().sort()).toEqual(["builder", "helper"]);
    // The discovered agent (instructions "I help.") wins over the map entry.
    const helper = api.get("helper") as { instructions: string } | null;
    expect(helper?.instructions).toBe("I help.");
    const warned = warnSpy.mock.calls
      .map((a) => a.join(" "))
      .some(
        (s) =>
          s.includes("both discovered") && s.includes("ignoring the map entry"),
      );
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  test("a map-only app with discovery disabled works unchanged (no throw)", async () => {
    const plugin = instantiate({
      dir: false,
      agents: {
        legacy: { instructions: "map agent", model: stubAdapter() },
      },
      defaultModel: stubAdapter(),
    });
    await plugin.setup();
    const api = plugin.exports() as ExportsApi;
    expect(api.list()).toEqual(["legacy"]);
    expect(api.getDefault()).toBe("legacy");
  });

  test("throws when defaultAgent names an unregistered agent", async () => {
    const plugin = instantiate({
      dir: fixtureDir("code-agents"),
      defaultAgent: "nope",
      defaultModel: stubAdapter(),
    });
    await expect(plugin.setup()).rejects.toThrow(/is not registered/);
  });

  test("throws when a folder holds both agent.ts and agent.md", async () => {
    const plugin = instantiate({
      dir: fixtureDir("code-md-collision"),
      defaultModel: stubAdapter(),
    });
    await expect(plugin.setup()).rejects.toThrow(
      /both a code agent .* and a markdown agent/,
    );
  });

  test("emits a one-time deprecation warning for agents({ agents }) and none for discovery", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const deprecated = instantiate({
      dir: false,
      agents: { legacy: { instructions: "x", model: stubAdapter() } },
    });
    await deprecated.setup();
    await deprecated.reload(); // must not re-warn

    const deprecationWarnings = warnSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((s) => s.includes("agents: { ... } }) is deprecated"));
    expect(deprecationWarnings).toHaveLength(1);

    warnSpy.mockClear();
    const discoveredPlugin = instantiate({
      dir: fixtureDir("code-agents"),
      defaultModel: stubAdapter(),
    });
    await discoveredPlugin.setup();

    const discoveryWarnings = warnSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((s) => s.includes("is deprecated"));
    expect(discoveryWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// The config/agents fallback is cwd-relative (path.resolve(cwd, "config/agents")),
// so these run in a temp cwd holding both roots rather than pointing `dir` at a
// fixture.
describe("AgentsPlugin config/agents deprecated fallback", () => {
  let tmp: string;
  let priorCwd: string;

  const write = (rel: string, content: string) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf-8");
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-fallback-"));
    priorCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(priorCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("merges config/agents markdown with server/agents (server wins) and warns once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("config/agents/legacy/agent.md", "---\n---\nLegacy only.");
    write("config/agents/shared/agent.md", "---\n---\nFrom config (old).");
    write("server/agents/shared/agent.md", "---\n---\nFrom server (new).");

    const plugin = instantiate({ defaultModel: stubAdapter() });
    await plugin.setup();
    await plugin.reload(); // must not re-warn

    const api = plugin.exports() as ExportsApi;
    expect(api.list().sort()).toEqual(["legacy", "shared"]);
    const shared = api.get("shared") as { instructions: string } | null;
    expect(shared?.instructions).toContain("From server (new).");

    const warns = warnSpy.mock.calls
      .map((a) => a.join(" "))
      .filter((s) => s.includes("config/agents/ are deprecated"));
    expect(warns).toHaveLength(1);
    warnSpy.mockRestore();
  });

  test("a server/agents parent resolves a sub-agent still in config/agents", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("config/agents/helper/agent.md", "---\n---\nI help.");
    write(
      "server/agents/planner/agent.md",
      "---\ndefault: true\nagents:\n  - helper\n---\nPlan.",
    );

    const plugin = instantiate({ defaultModel: stubAdapter() });
    await plugin.setup();

    const api = plugin.exports() as ExportsApi;
    expect(api.list().sort()).toEqual(["helper", "planner"]);
    expect(api.get("planner")?.toolIndex.has("agent-helper")).toBe(true);
    warnSpy.mockRestore();
  });

  test("dir:false disables the config/agents fallback too", async () => {
    write("config/agents/legacy/agent.md", "---\n---\nLegacy only.");
    const plugin = instantiate({
      dir: false,
      agents: { mapped: { instructions: "map", model: stubAdapter() } },
      defaultModel: stubAdapter(),
    });
    await plugin.setup();
    expect((plugin.exports() as ExportsApi).list()).toEqual(["mapped"]);
  });
});

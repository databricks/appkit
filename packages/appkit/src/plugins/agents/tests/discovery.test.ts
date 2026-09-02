import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentAdapter, AgentInput, AgentRunContext } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentsPluginConfig } from "../../../core/agent/types";
import { createTestPluginContext } from "../../../testing";
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

// One real context for the file: it carries the cache `setup()` reads, and its
// provider registry is empty, so tool collection finds nothing — as it did when
// these tests attached no context at all.
const kit = createTestPluginContext();

function instantiate(config: AgentsPluginConfig) {
  const plugin = new AgentsPlugin({ ...config, name: "agent" });
  plugin.attachContext({ context: kit.ctx });
  return plugin;
}

type ExportsApi = {
  list: () => string[];
  get: (name: string) => { toolIndex: Map<string, unknown> } | null;
  getDefault: () => string | null;
};

// Discovery scans `<cwd>/server/agents`, so each test runs in a fresh temp cwd.
// Code fixtures are symlinked in (not copied) so their `.ts` files resolve their
// relative imports from the committed location; markdown-only cases pass no
// fixture (an absent server/agents = empty discovery).
describe("AgentsPlugin agent discovery", () => {
  let restoreCwd: (() => void) | undefined;

  afterEach(() => {
    restoreCwd?.();
    restoreCwd = undefined;
  });

  function chdirWithAgents(fixture?: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-discovery-"));
    if (fixture) {
      fs.mkdirSync(path.join(tmp, "server"));
      fs.symlinkSync(
        fixtureDir(fixture),
        path.join(tmp, "server", "agents"),
        "dir",
      );
    }
    const prior = process.cwd();
    process.chdir(tmp);
    restoreCwd = () => {
      process.chdir(prior);
      fs.rmSync(tmp, { recursive: true, force: true });
    };
  }

  test("discovers code agents from server/agents", async () => {
    chdirWithAgents("code-agents");
    const plugin = instantiate({ defaultModel: stubAdapter() });
    await plugin.setup();

    const api = plugin.exports() as ExportsApi;
    // notAnAgent/ exports no created agent and is skipped.
    expect(api.list().sort()).toEqual(["builder", "helper"]);
    expect(api.getDefault()).toBe("builder");
  });

  test("honors default: true on a discovered code agent", async () => {
    chdirWithAgents("code-agents-default");
    const plugin = instantiate({ defaultModel: stubAdapter() });
    await plugin.setup();
    expect((plugin.exports() as ExportsApi).getDefault()).toBe("beta");
  });

  test("a discovered code default: true beats a markdown default: true", async () => {
    // code-agents-default holds beta (code, default:true) + planner (markdown,
    // default:true) side by side; code wins.
    chdirWithAgents("code-agents-default");
    const plugin = instantiate({ defaultModel: stubAdapter() });
    await plugin.setup();
    expect((plugin.exports() as ExportsApi).getDefault()).toBe("beta");
  });

  test("explicit defaultAgent overrides a discovered default: true", async () => {
    chdirWithAgents("code-agents-default");
    const plugin = instantiate({
      defaultAgent: "alpha",
      defaultModel: stubAdapter(),
    });
    await plugin.setup();
    expect((plugin.exports() as ExportsApi).getDefault()).toBe("alpha");
  });

  test("a markdown parent can delegate to a code sub-agent in a sibling folder", async () => {
    chdirWithAgents("md-parent-code-child");
    const plugin = instantiate({ defaultModel: stubAdapter() });
    await plugin.setup();

    const api = plugin.exports() as ExportsApi;
    expect(api.list().sort()).toEqual(["helper", "planner"]);
    expect(api.get("planner")?.toolIndex.has("agent-helper")).toBe(true);
    expect(api.getDefault()).toBe("planner");
  });

  test("discovery wins over a colliding deprecated-map entry (warns, no throw)", async () => {
    chdirWithAgents("code-agents");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = instantiate({
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

  test("a map-only app works unchanged when server/agents is absent (no throw)", async () => {
    chdirWithAgents();
    const plugin = instantiate({
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
    chdirWithAgents("code-agents");
    const plugin = instantiate({
      defaultAgent: "nope",
      defaultModel: stubAdapter(),
    });
    await expect(plugin.setup()).rejects.toThrow(/is not registered/);
  });

  test("throws when a folder holds both agent.ts and agent.md", async () => {
    chdirWithAgents("code-md-collision");
    const plugin = instantiate({ defaultModel: stubAdapter() });
    await expect(plugin.setup()).rejects.toThrow(
      /both a code agent .* and a markdown agent/,
    );
  });

  test("emits a one-time deprecation warning for agents({ agents }) and none for discovery", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    chdirWithAgents();
    const deprecated = instantiate({
      agents: { legacy: { instructions: "x", model: stubAdapter() } },
    });
    await deprecated.setup();
    await deprecated.reload(); // must not re-warn

    const deprecationWarnings = warnSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((s) => s.includes("agents: { ... } }) is deprecated"));
    expect(deprecationWarnings).toHaveLength(1);

    warnSpy.mockClear();
    restoreCwd?.();
    chdirWithAgents("code-agents");
    const discoveredPlugin = instantiate({ defaultModel: stubAdapter() });
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
});

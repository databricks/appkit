import { describe, expect, test, vi } from "vitest";

import type { SkillDefinition } from "../../../core/agent/skills";
import { resolveSkillCatalog } from "../../../core/agent/skills";
import { AgentsPlugin } from "../agents";

/**
 * Phase 4 — the server surfaces the skill catalog to the client via
 * `clientConfig()`, and force-loads a skill for a turn via `renderForcedSkill`
 * (the deterministic `/skill-name` path). Both are pure and don't touch a
 * workspace, so no mocks are needed.
 */

function skill(
  name: string,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    body: `${name} body`,
    source: "bundle-agent",
    dir: `/fake/${name}`,
    files: [],
    ...overrides,
  };
}

function catalogOf(...skills: SkillDefinition[]) {
  return resolveSkillCatalog({
    agentName: "a",
    perAgentSkills: skills,
    globalSkills: [],
    autoInherit: false,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: minimal RegisteredAgent stub
function registeredWith(catalog?: ReturnType<typeof catalogOf>): any {
  return {
    name: "a",
    instructions: "",
    adapter: {},
    toolIndex: new Map(),
    ...(catalog ? { skills: catalog } : {}),
  };
}

describe("skills are wired uniformly for every registered agent", () => {
  // Sub-agents are ordinary registered agents resolved through
  // buildRegisteredAgent, so opting one into a skill gives it the same
  // catalog + load_skill/read_skill_file tools as a top-level agent.
  test("buildRegisteredAgent gives a code agent its catalog and skill tools", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: seed the shared pool
    (plugin as any).globalSkills = [skill("x", { description: "X skill" })];

    // biome-ignore lint/suspicious/noExplicitAny: call private with a stub adapter
    const registered = await (plugin as any).buildRegisteredAgent(
      "child",
      {
        instructions: "hi",
        model: {
          run: async function* () {},
          acceptsExtensions: [],
          consumesInputTools: false,
        },
        skills: ["x"],
      },
      { origin: "code" },
    );

    expect(registered.skills?.byAddress.has("x")).toBe(true);
    expect(registered.toolIndex.has("load_skill")).toBe(true);
    expect(registered.toolIndex.has("read_skill_file")).toBe(true);
  });

  test("an agent with no visible skills gets no skill tools", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: call private with a stub adapter
    const registered = await (plugin as any).buildRegisteredAgent(
      "bare",
      { instructions: "hi", model: { run: async function* () {} } },
      { origin: "code" },
    );
    expect(registered.skills).toBeUndefined();
    expect(registered.toolIndex.has("load_skill")).toBe(false);
  });
});

describe("clientConfig — skills", () => {
  test("exposes each agent's skill catalog keyed by agent name", () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: seed private registry
    (plugin as any).agents = new Map([
      [
        "helper",
        registeredWith(catalogOf(skill("pdf", { description: "PDFs" }))),
      ],
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: seed private field
    (plugin as any).defaultAgentName = "helper";

    const cfg = plugin.clientConfig();
    expect(cfg.agents).toEqual(["helper"]);
    expect(cfg.skills).toEqual({
      helper: [{ name: "pdf", description: "PDFs" }],
    });
  });

  test("omits agents that have no visible catalog", () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: seed private registry
    (plugin as any).agents = new Map([["bare", registeredWith()]]);
    expect(plugin.clientConfig().skills).toEqual({});
  });
});

describe("renderForcedSkill", () => {
  test("renders the resolved skill body with a request note", () => {
    const plugin = new AgentsPlugin({ dir: false });
    const registered = registeredWith(
      catalogOf(skill("pdf", { body: "PDF steps." })),
    );
    // biome-ignore lint/suspicious/noExplicitAny: call private
    const out = (plugin as any).renderForcedSkill(registered, "pdf");
    expect(out).toContain("PDF steps.");
    expect(out).toContain("explicitly requested");
  });

  test("returns null for an unknown forced skill", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = new AgentsPlugin({ dir: false });
    const registered = registeredWith(catalogOf(skill("pdf")));
    // biome-ignore lint/suspicious/noExplicitAny: call private
    expect((plugin as any).renderForcedSkill(registered, "ghost")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("returns null when the agent has no catalog", () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: call private
    expect(
      (plugin as any).renderForcedSkill(registeredWith(), "pdf"),
    ).toBeNull();
  });
});

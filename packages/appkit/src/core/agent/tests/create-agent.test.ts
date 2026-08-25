import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createAgent, isCreatedAgent } from "../create-agent";
import { tool } from "../tools/tool";
import type { AgentDefinition } from "../types";

describe("createAgent", () => {
  test("returns the definition unchanged for a simple agent", () => {
    const def: AgentDefinition = {
      name: "support",
      instructions: "You help customers.",
      model: "endpoint-x",
    };
    const result = createAgent(def);
    expect(result).toBe(def);
  });

  test("accepts tools as a keyed record", () => {
    const get_weather = tool({
      name: "get_weather",
      description: "Get the weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny in ${city}`,
    });

    const def = createAgent({
      instructions: "...",
      tools: { get_weather },
    });

    // The object form preserves identity; we narrow with typeof to satisfy
    // the dual ToolRecord | AgentToolsFn shape.
    expect(typeof def.tools).toBe("object");
    if (typeof def.tools === "object") {
      expect(def.tools.get_weather).toBe(get_weather);
    }
  });

  test("name is optional (id is derived elsewhere)", () => {
    const def = createAgent({ instructions: "no name here" });
    expect(def.name).toBeUndefined();
    expect(def.instructions).toBe("no name here");
  });

  test("carries the default flag through unchanged", () => {
    const def = createAgent({
      instructions: "I am the default.",
      default: true,
    });
    expect(def.default).toBe(true);
  });

  test("brands the result so the code-agent loader can recognize it", () => {
    const def = createAgent({ instructions: "branded" });
    expect(isCreatedAgent(def)).toBe(true);
    // The brand is non-enumerable — invisible to spread and JSON.
    expect(Object.keys(def)).not.toContain("Symbol(appkit.agent)");
    expect(JSON.parse(JSON.stringify(def))).toEqual({
      instructions: "branded",
    });
    // Plain objects are not agents.
    expect(isCreatedAgent({ instructions: "not made by createAgent" })).toBe(
      false,
    );
    expect(isCreatedAgent(null)).toBe(false);
  });

  test("accepts sub-agents in a keyed record", () => {
    const researcher = createAgent({ instructions: "Research." });
    const supervisor = createAgent({
      instructions: "Supervise.",
      agents: { researcher },
    });
    expect(supervisor.agents?.researcher).toBe(researcher);
  });

  test("throws on a direct self-cycle", () => {
    const a: AgentDefinition = { instructions: "a" };
    (a as any).agents = { self: a };
    expect(() => createAgent(a)).toThrow(/cycle/i);
  });

  test("throws on an indirect cycle", () => {
    const a: AgentDefinition = { instructions: "a" };
    const b: AgentDefinition = { instructions: "b" };
    a.agents = { b };
    b.agents = { a };
    expect(() => createAgent(a)).toThrow(/cycle/i);
  });

  test("accepts a DAG of sub-agents without throwing", () => {
    const leaf: AgentDefinition = { instructions: "leaf" };
    const branchA: AgentDefinition = {
      instructions: "a",
      agents: { leaf },
    };
    const branchB: AgentDefinition = {
      instructions: "b",
      agents: { leaf },
    };
    const root = createAgent({
      instructions: "root",
      agents: { branchA, branchB },
    });
    expect(root.agents?.branchA.agents?.leaf).toBe(leaf);
    expect(root.agents?.branchB.agents?.leaf).toBe(leaf);
  });
});

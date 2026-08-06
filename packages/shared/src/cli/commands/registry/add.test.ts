import { describe, expect, it, vi } from "vitest";
import { resolveItems, scopesForResources } from "./add";
import type { RegistryItem } from "./client";
import type { ResourceRequirementRow } from "./requirements";

function item(name: string, extra: Partial<RegistryItem> = {}): RegistryItem {
  return { name, ...extra };
}

function resourceRow(type: string): ResourceRequirementRow {
  return { type, required: true, fields: [] };
}

describe("resolveItems", () => {
  it("returns requested items in order", async () => {
    const fetch = vi.fn(async (name: string) => item(name));
    const result = await resolveItems(["a", "b"], null, fetch);
    expect(result.map((i) => i.name)).toEqual(["a", "b"]);
  });

  // Bugs #1 + #3: registryDependencies were ignored on plugins and never
  // resolved transitively.
  it("resolves transitive registryDependencies", async () => {
    const graph: Record<string, RegistryItem> = {
      a: item("a", { registryDependencies: ["b"] }),
      b: item("b", { registryDependencies: ["c"] }),
      c: item("c"),
    };
    const fetch = vi.fn(async (name: string) => graph[name]);
    const result = await resolveItems(["a"], null, fetch);
    expect(result.map((i) => i.name)).toEqual(["a", "b", "c"]);
  });

  it("de-duplicates shared dependencies and fetches each once", async () => {
    const graph: Record<string, RegistryItem> = {
      a: item("a", { registryDependencies: ["shared"] }),
      b: item("b", { registryDependencies: ["shared"] }),
      shared: item("shared"),
    };
    const fetch = vi.fn(async (name: string) => graph[name]);
    const result = await resolveItems(["a", "b"], null, fetch);
    expect(result.map((i) => i.name)).toEqual(["a", "b", "shared"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not loop on circular dependencies", async () => {
    const graph: Record<string, RegistryItem> = {
      a: item("a", { registryDependencies: ["b"] }),
      b: item("b", { registryDependencies: ["a"] }),
    };
    const fetch = vi.fn(async (name: string) => graph[name]);
    const result = await resolveItems(["a"], null, fetch);
    expect(result.map((i) => i.name)).toEqual(["a", "b"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("strips the namespace from dependency refs", async () => {
    const graph: Record<string, RegistryItem> = {
      a: item("a", { registryDependencies: ["@databricks-appkit/b"] }),
      b: item("b"),
    };
    const fetch = vi.fn(async (name: string) => graph[name]);
    const result = await resolveItems(["a"], null, fetch);
    expect(result.map((i) => i.name)).toEqual(["a", "b"]);
  });
});

describe("scopesForResources", () => {
  it("maps scope-needing resource types to their user_api_scope", () => {
    const scopes = scopesForResources([
      resourceRow("genie_space"),
      resourceRow("serving_endpoint"),
      resourceRow("volume"),
    ]);
    expect(Object.fromEntries(scopes)).toEqual({
      genie_space: "dashboards.genie",
      serving_endpoint: "serving.serving-endpoints",
      volume: "files.files",
    });
  });

  it("returns empty for resources that need no scope", () => {
    expect(scopesForResources([resourceRow("sql_warehouse")]).size).toBe(0);
  });

  it("de-dupes repeated types", () => {
    const scopes = scopesForResources([
      resourceRow("genie_space"),
      resourceRow("genie_space"),
    ]);
    expect(scopes.size).toBe(1);
  });
});

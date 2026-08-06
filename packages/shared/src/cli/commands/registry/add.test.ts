import { describe, expect, it, vi } from "vitest";
import { resolveItems } from "./add";
import type { RegistryItem } from "./client";

function item(name: string, extra: Partial<RegistryItem> = {}): RegistryItem {
  return { name, ...extra };
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

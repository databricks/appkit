import { describe, expect, it, vi } from "vitest";
import { declaredEnvVars, resolveItems } from "./add";
import type { RegistryItem } from "./client";

function item(name: string, extra: Partial<RegistryItem> = {}): RegistryItem {
  return { name, ...extra };
}

describe("declaredEnvVars", () => {
  it("collects env vars from required resources", () => {
    const manifest = {
      resources: {
        required: [{ fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } } }],
      },
    };
    expect(declaredEnvVars(manifest)).toEqual(["DATABRICKS_WAREHOUSE_ID"]);
  });

  // Bug #2: optional resources were dropped entirely.
  it("also collects env vars from optional resources", () => {
    const manifest = {
      resources: {
        required: [{ fields: { id: { env: "REQUIRED_ENV" } } }],
        optional: [{ fields: { id: { env: "OPTIONAL_ENV" } } }],
      },
    };
    expect(declaredEnvVars(manifest)).toEqual(["REQUIRED_ENV", "OPTIONAL_ENV"]);
  });

  it("skips fields without an env property", () => {
    const manifest = {
      resources: {
        required: [{ fields: { host: { env: "PGHOST" }, note: {} } }],
      },
    };
    expect(declaredEnvVars(manifest)).toEqual(["PGHOST"]);
  });

  it("returns empty for a manifest with no resources", () => {
    expect(declaredEnvVars({})).toEqual([]);
  });
});

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

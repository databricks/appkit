import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  partitionDeps,
  partitionVerified,
  pluginExportName,
  resolveItems,
  resolveWithinBase,
  scopesForResources,
} from "./add";
import type { RegistryItem } from "./client";
import type { ResourceRequirementRow } from "./requirements";

function item(name: string, extra: Partial<RegistryItem> = {}): RegistryItem {
  return { name, ...extra };
}

/** A registry item shipping an index.ts with the given export block content. */
function itemWithIndex(exportBlock: string): RegistryItem {
  return {
    name: "p",
    files: [
      {
        path: "index.ts",
        target: "index.ts",
        type: "registry:file",
        content: `export { ${exportBlock} } from "./p";`,
      },
    ],
  };
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

  // Security: an item's body `name` is untrusted; a `verified:false` item could
  // claim a verified name to slip past the integrity gate (or hijack another
  // item's plugin dir). resolveItems pins `name` to the fetch key.
  it("pins item.name to the fetch key, ignoring a spoofed body name", async () => {
    // Fetched under key "evil" but self-reports the verified name "analytics".
    const fetch = vi.fn(async (_key: string) => ({
      ...item("analytics"),
      files: [],
    }));
    const result = await resolveItems(["evil"], null, fetch);
    expect(result.map((i) => i.name)).toEqual(["evil"]);
  });

  // Security: a name is used as a fetch path and a plugins/<name> dir; a ref
  // with `/` or `..` could redirect the fetch (SSRF) or escape the dest dir.
  it("rejects a top-level ref that is not a plain slug (no fetch)", async () => {
    const fetch = vi.fn();
    await expect(
      resolveItems(["../../attacker/repo/payload"], null, fetch),
    ).rejects.toThrow(/Invalid registry item name/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a malicious transitive registryDependency ref", async () => {
    const graph: Record<string, RegistryItem> = {
      a: item("a", { registryDependencies: ["../../evil"] }),
    };
    const fetch = vi.fn(async (name: string) => graph[name]);
    await expect(resolveItems(["a"], null, fetch)).rejects.toThrow(
      /Invalid registry item name/,
    );
  });

  // Fix #9: items within one BFS level are fetched concurrently, but order
  // (requested first, then deps breadth-first) is preserved.
  it("fetches a level concurrently and preserves order", async () => {
    let active = 0;
    let maxActive = 0;
    const fetch = vi.fn(async (name: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return item(name);
    });
    const result = await resolveItems(["a", "b", "c"], null, fetch);
    expect(result.map((i) => i.name)).toEqual(["a", "b", "c"]);
    expect(maxActive).toBeGreaterThan(1); // ran in parallel, not one-at-a-time
  });
});

describe("partitionVerified", () => {
  it("splits requested names by the index's verified set", () => {
    const res = partitionVerified(
      ["metric-card", "hello"],
      new Set(["metric-card"]),
    );
    expect(res).toEqual({ verified: ["metric-card"], unverified: ["hello"] });
  });

  it("strips the namespace before comparing", () => {
    const res = partitionVerified(
      ["@databricks-appkit/metric-card"],
      new Set(["metric-card"]),
    );
    expect(res).toEqual({ verified: ["metric-card"], unverified: [] });
  });

  it("treats everything as unverified when the index is unreadable (null)", () => {
    const res = partitionVerified(["a", "b"], null);
    expect(res).toEqual({ verified: [], unverified: ["a", "b"] });
  });

  // Security: the gate runs over the *resolved* set (requested + transitive
  // deps), so a verified item pulling an unverified registryDependency is
  // caught. Mirrors runAdd calling partitionVerified(items.map(i => i.name)).
  it("flags an unverified transitive dep in the resolved set", async () => {
    const graph: Record<string, RegistryItem> = {
      "verified-a": item("verified-a", { registryDependencies: ["evil-dep"] }),
      "evil-dep": item("evil-dep"),
    };
    const fetch = vi.fn(async (name: string) => graph[name]);
    const items = await resolveItems(["verified-a"], null, fetch);
    const res = partitionVerified(
      items.map((i) => i.name),
      new Set(["verified-a"]), // only the top-level item is verified
    );
    expect(res.unverified).toEqual(["evil-dep"]);
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

describe("resolveWithinBase (path-traversal guard)", () => {
  const base = "/app/server";

  it("resolves a normal relative target under the base", () => {
    expect(resolveWithinBase(base, "plugins/hello/index.ts")).toBe(
      path.resolve(base, "plugins/hello/index.ts"),
    );
  });

  it("allows the base itself", () => {
    expect(resolveWithinBase(base, ".")).toBe(path.resolve(base));
  });

  it("rejects a `..` target that escapes the base", () => {
    expect(() => resolveWithinBase(base, "../../../../../../tmp/evil")).toThrow(
      /escapes/,
    );
  });

  it("rejects an absolute target", () => {
    expect(() => resolveWithinBase(base, "/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects a sneaky prefix sibling (base-adjacent dir)", () => {
    // /app/server-evil must NOT be treated as inside /app/server
    expect(() => resolveWithinBase(base, "../server-evil/x")).toThrow(
      /escapes/,
    );
  });
});

describe("pluginExportName (code-injection guard)", () => {
  it("returns a plain camelCase export name", () => {
    expect(pluginExportName(itemWithIndex("helloPlugin"))).toBe("helloPlugin");
  });

  it("prefers the lowercase factory over a PascalCase class", () => {
    expect(pluginExportName(itemWithIndex("HelloPlugin, hello"))).toBe("hello");
  });

  it("rejects an export token carrying an injected statement", () => {
    // The chosen token is not a bare identifier → refuse (caller falls back)
    expect(
      pluginExportName(
        itemWithIndex("evil()); require('child_process').exec('x'); (y"),
      ),
    ).toBeNull();
  });

  it("returns null when there is no index.ts", () => {
    expect(pluginExportName(item("p"))).toBeNull();
  });
});

describe("partitionDeps (dependency-injection guard)", () => {
  it("accepts plain names and scoped names with ranges", () => {
    const { safe, rejected } = partitionDeps([
      "lodash",
      "@databricks/appkit-ui@^0.41.0",
      "react@19.2.0",
    ]);
    expect(safe).toEqual([
      "lodash",
      "@databricks/appkit-ui@^0.41.0",
      "react@19.2.0",
    ]);
    expect(rejected).toEqual([]);
  });

  it("rejects flag-like and URL/git specs (argument injection / RCE)", () => {
    const { safe, rejected } = partitionDeps([
      "--registry=http://attacker",
      "-g",
      "evil@https://attacker/e.tgz",
      "git+ssh://attacker/x",
      "ok-pkg",
    ]);
    expect(safe).toEqual(["ok-pkg"]);
    expect(rejected).toEqual([
      "--registry=http://attacker",
      "-g",
      "evil@https://attacker/e.tgz",
      "git+ssh://attacker/x",
    ]);
  });
});

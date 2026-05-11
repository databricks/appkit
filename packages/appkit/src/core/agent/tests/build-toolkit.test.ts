import { describe, expect, test } from "vitest";
import { z } from "zod";
import { buildToolkitEntries } from "../build-toolkit";
import { defineTool, type ToolRegistry } from "../tools/define-tool";
import { isToolkitEntry } from "../types";

const registry: ToolRegistry = {
  query: defineTool({
    description: "Run a query",
    schema: z.object({ sql: z.string() }),
    handler: () => "ok",
  }),
  history: defineTool({
    description: "Get query history",
    schema: z.object({}),
    handler: () => [],
  }),
};

describe("buildToolkitEntries", () => {
  test("produces ToolkitEntry per registry item with default dotted prefix", () => {
    const entries = buildToolkitEntries("analytics", registry);
    expect(Object.keys(entries).sort()).toEqual([
      "analytics.history",
      "analytics.query",
    ]);
    for (const entry of Object.values(entries)) {
      expect(isToolkitEntry(entry)).toBe(true);
      expect(entry.pluginName).toBe("analytics");
    }
  });

  test("respects prefix option (empty drops the namespace)", () => {
    const entries = buildToolkitEntries("analytics", registry, { prefix: "" });
    expect(Object.keys(entries).sort()).toEqual(["history", "query"]);
  });

  test("respects custom prefix", () => {
    const entries = buildToolkitEntries("analytics", registry, {
      prefix: "db.",
    });
    expect(Object.keys(entries).sort()).toEqual(["db.history", "db.query"]);
  });

  test("only filter keeps the listed local names", () => {
    const entries = buildToolkitEntries("analytics", registry, {
      only: ["query"],
    });
    expect(Object.keys(entries)).toEqual(["analytics.query"]);
  });

  test("except filter drops the listed local names", () => {
    const entries = buildToolkitEntries("analytics", registry, {
      except: ["history"],
    });
    expect(Object.keys(entries)).toEqual(["analytics.query"]);
  });

  test("rename remaps specific local names (overrides the prefix key)", () => {
    const entries = buildToolkitEntries("analytics", registry, {
      rename: { query: "sql" },
    });
    expect(Object.keys(entries).sort()).toEqual(["analytics.history", "sql"]);
  });

  test("exposes the original plugin+local name so dispatch can route", () => {
    const entries = buildToolkitEntries("analytics", registry, {
      prefix: "db.",
    });
    const qEntry = entries["db.query"];
    expect(qEntry.pluginName).toBe("analytics");
    expect(qEntry.localName).toBe("query");
    expect(qEntry.def.name).toBe("db.query");
  });

  test("propagates autoInheritable from the source registry", () => {
    const mixed: ToolRegistry = {
      readIt: defineTool({
        description: "safe read",
        schema: z.object({}),
        autoInheritable: true,
        handler: () => "ok",
      }),
      writeIt: defineTool({
        description: "unsafe write",
        schema: z.object({}),
        autoInheritable: false,
        handler: () => "ok",
      }),
      unmarked: defineTool({
        description: "default: not auto-inheritable",
        schema: z.object({}),
        handler: () => "ok",
      }),
    };
    const entries = buildToolkitEntries("p", mixed);
    expect(entries["p.readIt"].autoInheritable).toBe(true);
    expect(entries["p.writeIt"].autoInheritable).toBe(false);
    expect(entries["p.unmarked"].autoInheritable).toBeUndefined();
  });
});

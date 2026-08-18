import { describe, expect, it } from "vitest";

import type { RegistryItem } from "./client";
import {
  extractRequirements,
  fieldOrigin,
  isValidEnvName,
  renderRequirements,
} from "./requirements";

function pluginItem(manifest: unknown): RegistryItem {
  return {
    name: "analytics",
    files: [
      {
        path: "manifest.json",
        target: "manifest.json",
        type: "registry:file",
        content: JSON.stringify(manifest),
      },
    ],
  };
}

const ANALYTICS_MANIFEST = {
  name: "analytics",
  resources: {
    required: [
      {
        type: "sql_warehouse",
        resourceKey: "sql-warehouse",
        permission: "CAN_USE",
        description: "SQL warehouse for queries",
        fields: {
          id: { env: "DATABRICKS_WAREHOUSE_ID", origin: "user" },
        },
      },
    ],
    optional: [
      {
        type: "volume",
        fields: { name: { env: "VOLUME_NAME", origin: "user" } },
      },
    ],
  },
};

describe("extractRequirements", () => {
  it("returns required rows first, then optional", () => {
    const rows = extractRequirements(pluginItem(ANALYTICS_MANIFEST));
    expect(rows.map((r) => [r.type, r.required])).toEqual([
      ["sql_warehouse", true],
      ["volume", false],
    ]);
  });

  it("captures permission, fields, env and origin", () => {
    const [warehouse] = extractRequirements(pluginItem(ANALYTICS_MANIFEST));
    expect(warehouse.permission).toBe("CAN_USE");
    expect(warehouse.fields).toEqual([
      {
        key: "id",
        env: "DATABRICKS_WAREHOUSE_ID",
        origin: "user",
        description: undefined,
      },
    ]);
  });

  it("returns empty for a UI item with no manifest", () => {
    const ui: RegistryItem = {
      name: "metric-card",
      files: [
        {
          path: "metric-card.tsx",
          target: "components/metric-card.tsx",
          type: "registry:component",
          content: "export const MetricCard = () => null;",
        },
      ],
    };
    expect(extractRequirements(ui)).toEqual([]);
  });

  it("returns empty for a plugin with no declared resources", () => {
    const rows = extractRequirements(
      pluginItem({ name: "hello", resources: { required: [], optional: [] } }),
    );
    expect(rows).toEqual([]);
  });

  it("tolerates malformed manifest json", () => {
    const item: RegistryItem = {
      name: "broken",
      files: [
        {
          path: "manifest.json",
          target: "manifest.json",
          type: "registry:file",
          content: "{ not json",
        },
      ],
    };
    expect(extractRequirements(item)).toEqual([]);
  });
});

describe("renderRequirements", () => {
  it("renders a no-requirements line for items without resources", () => {
    const out = renderRequirements(pluginItem({ name: "hello" }));
    expect(out).toContain("no resource requirements");
  });

  it("lists each resource with its env vars and origin", () => {
    const out = renderRequirements(pluginItem(ANALYTICS_MANIFEST));
    expect(out).toContain("sql_warehouse");
    expect(out).toContain("required");
    expect(out).toContain("CAN_USE");
    expect(out).toContain("DATABRICKS_WAREHOUSE_ID");
    expect(out).toContain("volume");
    expect(out).toContain("optional");
    expect(out).toContain("VOLUME_NAME");
  });
});

describe("fieldOrigin", () => {
  it("trusts an explicit computed origin (synced manifest)", () => {
    expect(fieldOrigin({ key: "id", origin: "platform" })).toBe("platform");
    expect(fieldOrigin({ key: "id", origin: "user" })).toBe("user");
  });

  it("derives platform from localOnly when origin is absent", () => {
    expect(fieldOrigin({ key: "host", localOnly: true })).toBe("platform");
  });

  it("derives static from a default value when origin is absent", () => {
    expect(fieldOrigin({ key: "port", value: "5432" })).toBe("static");
  });

  it("derives cli from a resolve key when origin is absent", () => {
    expect(fieldOrigin({ key: "endpoint", resolve: "postgres:host" })).toBe(
      "cli",
    );
  });

  it("defaults a bare env field to user", () => {
    expect(fieldOrigin({ key: "id", env: "DATABRICKS_WAREHOUSE_ID" })).toBe(
      "user",
    );
  });

  it("gives localOnly precedence over a default value", () => {
    expect(fieldOrigin({ key: "port", localOnly: true, value: "5432" })).toBe(
      "platform",
    );
  });
});

describe("isValidEnvName", () => {
  it("accepts plain env identifiers", () => {
    expect(isValidEnvName("DATABRICKS_WAREHOUSE_ID")).toBe(true);
    expect(isValidEnvName("_private")).toBe(true);
    expect(isValidEnvName("PORT2")).toBe(true);
  });

  it("rejects names with a newline, space, or leading digit", () => {
    expect(isValidEnvName("PORT=x\nDATABRICKS_HOST=evil")).toBe(false);
    expect(isValidEnvName("has space")).toBe(false);
    expect(isValidEnvName("2FOO")).toBe(false);
    expect(isValidEnvName("")).toBe(false);
    expect(isValidEnvName("FOO=BAR")).toBe(false);
  });
});

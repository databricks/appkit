import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTargetsFromCwd,
  targetsFromManifestFile,
} from "./resolve-targets";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doctor-targets-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const MANIFEST = {
  version: "2.0",
  plugins: {
    analytics: {
      resources: {
        required: [
          {
            type: "sql_warehouse",
            resourceKey: "sql-warehouse",
            alias: "SQL Warehouse",
            permission: "CAN_USE",
            fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
          },
        ],
        optional: [],
      },
    },
    agents: {
      resources: {
        required: [],
        optional: [
          {
            type: "serving_endpoint",
            resourceKey: "serving",
            alias: "Chat model",
            permission: "CAN_QUERY",
            fields: { name: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } },
          },
        ],
      },
    },
    server: { resources: { required: [], optional: [] } },
  },
};

describe("targetsFromManifestFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) cleanDir(d);
    dirs.length = 0;
  });

  function writeManifest(obj: unknown): string {
    const dir = makeTempDir();
    dirs.push(dir);
    const p = path.join(dir, "appkit.plugins.json");
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("flattens required and optional resources across plugins", () => {
    const targets = targetsFromManifestFile(writeManifest(MANIFEST));
    expect(targets).toHaveLength(2);

    const warehouse = targets.find((t) => t.type === "sql_warehouse");
    expect(warehouse).toMatchObject({
      type: "sql_warehouse",
      resourceKey: "sql-warehouse",
      alias: "SQL Warehouse",
      plugin: "analytics",
      requiredPermission: "CAN_USE",
      required: true,
      envVars: ["DATABRICKS_WAREHOUSE_ID"],
    });

    const serving = targets.find((t) => t.type === "serving_endpoint");
    expect(serving).toMatchObject({
      plugin: "agents",
      required: false,
      envVars: ["DATABRICKS_SERVING_ENDPOINT_NAME"],
    });
  });

  it("excludes value-default and platform-injected fields from envVars (regression: bug #3)", () => {
    const targets = targetsFromManifestFile(
      writeManifest({
        version: "2.0",
        plugins: {
          lakebase: {
            resources: {
              required: [
                {
                  type: "postgres",
                  resourceKey: "pg",
                  alias: "Postgres",
                  permission: "CAN_CONNECT_AND_CREATE",
                  fields: {
                    endpointPath: { env: "LAKEBASE_ENDPOINT", origin: "cli" },
                    host: {
                      env: "PGHOST",
                      localOnly: true,
                      origin: "platform",
                    },
                    port: {
                      env: "PGPORT",
                      value: "5432",
                      localOnly: true,
                      origin: "platform",
                    },
                    sslmode: {
                      env: "PGSSLMODE",
                      value: "require",
                      localOnly: true,
                      origin: "platform",
                    },
                  },
                },
              ],
              optional: [],
            },
          },
        },
      }),
    );
    const pg = targets.find((t) => t.type === "postgres");
    // Only the user-supplied endpoint is presence-checked; value-default and
    // platform-injected fields must not be flagged as missing.
    expect(pg?.envVars).toEqual(["LAKEBASE_ENDPOINT"]);
  });

  it("returns an empty list for a manifest with no resources", () => {
    const targets = targetsFromManifestFile(
      writeManifest({ version: "2.0", plugins: { server: {} } }),
    );
    expect(targets).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const p = path.join(dir, "appkit.plugins.json");
    fs.writeFileSync(p, "{ not json");
    expect(() => targetsFromManifestFile(p)).toThrow(/Failed to parse/);
  });
});

describe("resolveTargetsFromCwd", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) cleanDir(d);
    dirs.length = 0;
  });

  it("returns an empty list when no manifest is present", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    expect(resolveTargetsFromCwd(dir)).toEqual([]);
  });

  it("reads the manifest from the given cwd", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "appkit.plugins.json"),
      JSON.stringify(MANIFEST),
    );
    expect(resolveTargetsFromCwd(dir)).toHaveLength(2);
  });
});

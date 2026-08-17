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
      requiredByTemplate: true,
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
      requiredByTemplate: true,
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
    server: {
      requiredByTemplate: true,
      resources: { required: [], optional: [] },
    },
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

  it("checks only requiredByTemplate plugins when any are marked", () => {
    // analytics is marked (used in the app); agents is discovered-but-unused.
    const targets = targetsFromManifestFile(
      writeManifest({
        version: "2.0",
        plugins: {
          analytics: {
            requiredByTemplate: true,
            resources: {
              required: [
                {
                  type: "sql_warehouse",
                  resourceKey: "sql-warehouse",
                  permission: "CAN_USE",
                  fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
                },
              ],
            },
          },
          agents: {
            // no requiredByTemplate → discovered but not used → skipped
            resources: {
              optional: [
                {
                  type: "serving_endpoint",
                  resourceKey: "serving",
                  permission: "CAN_QUERY",
                  fields: { name: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } },
                },
              ],
            },
          },
        },
      }),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].plugin).toBe("analytics");
  });

  it("returns nothing when no plugin is marked requiredByTemplate", () => {
    // A manifest whose plugins are all discovered-but-unused → nothing to check.
    const targets = targetsFromManifestFile(
      writeManifest({
        version: "2.0",
        plugins: {
          analytics: {
            resources: {
              required: [
                {
                  type: "sql_warehouse",
                  resourceKey: "sql-warehouse",
                  permission: "CAN_USE",
                  fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
                },
              ],
            },
          },
        },
      }),
    );
    expect(targets).toEqual([]);
  });

  it("keeps only user-supplied fields, excluding cli/platform/static ones", () => {
    // A synced manifest stamps `origin`. Only the user-supplied field should
    // reach envVars; the cli-, platform-, and static-origin fields are excluded.
    const targets = targetsFromManifestFile(
      writeManifest({
        version: "2.0",
        plugins: {
          lakebase: {
            requiredByTemplate: true,
            resources: {
              required: [
                {
                  type: "postgres",
                  resourceKey: "pg",
                  alias: "Postgres",
                  permission: "CAN_CONNECT_AND_CREATE",
                  fields: {
                    instanceName: {
                      env: "LAKEBASE_INSTANCE_NAME",
                      origin: "user",
                    },
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
    expect(pg?.envVars).toEqual(["LAKEBASE_INSTANCE_NAME"]);
  });

  it("excludes cli-origin fields, whether stamped or derived from `resolve`", () => {
    // A stamped `origin: "cli"` (synced manifest) and an unstamped field with
    // `resolve` (authored manifest) must both be treated as non-user, so
    // doctor never reports them as MISSING user env vars.
    const targets = targetsFromManifestFile(
      writeManifest({
        version: "2.0",
        plugins: {
          lakebase: {
            requiredByTemplate: true,
            resources: {
              required: [
                {
                  type: "postgres",
                  resourceKey: "pg",
                  alias: "Postgres",
                  permission: "CAN_CONNECT_AND_CREATE",
                  fields: {
                    // synced manifest: origin stamped by `plugin sync`
                    stampedCli: { env: "LAKEBASE_ENDPOINT", origin: "cli" },
                    // authored manifest: no stamped origin, resolve → cli
                    derivedCli: {
                      env: "LAKEBASE_HOST",
                      resolve: "postgres:host",
                    },
                    // genuine user-supplied field survives
                    user: { env: "LAKEBASE_INSTANCE_NAME" },
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
    expect(pg?.envVars).toEqual(["LAKEBASE_INSTANCE_NAME"]);
  });

  it("resolves fieldValues from a static `value` when the env var is unset", () => {
    delete process.env.SOME_UNSET_ENV;
    const targets = targetsFromManifestFile(
      writeManifest({
        version: "2.0",
        plugins: {
          demo: {
            requiredByTemplate: true,
            resources: {
              required: [
                {
                  type: "sql_warehouse",
                  resourceKey: "wh",
                  alias: "WH",
                  permission: "CAN_USE",
                  fields: {
                    id: { env: "SOME_UNSET_ENV", value: "baked-in-id" },
                  },
                },
              ],
              optional: [],
            },
          },
        },
      }),
    );
    const wh = targets.find((t) => t.type === "sql_warehouse");
    expect(wh?.fieldValues.id).toBe("baked-in-id");
  });

  it("prefers the env value over a static `value` default", () => {
    process.env.DOCTOR_ENV_WINS = "from-env";
    try {
      const targets = targetsFromManifestFile(
        writeManifest({
          version: "2.0",
          plugins: {
            demo: {
              requiredByTemplate: true,
              resources: {
                required: [
                  {
                    type: "sql_warehouse",
                    resourceKey: "wh",
                    alias: "WH",
                    permission: "CAN_USE",
                    fields: {
                      id: { env: "DOCTOR_ENV_WINS", value: "baked-in-id" },
                    },
                  },
                ],
                optional: [],
              },
            },
          },
        }),
      );
      const wh = targets.find((t) => t.type === "sql_warehouse");
      expect(wh?.fieldValues.id).toBe("from-env");
    } finally {
      delete process.env.DOCTOR_ENV_WINS;
    }
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
});

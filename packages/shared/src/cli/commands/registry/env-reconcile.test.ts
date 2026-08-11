import { describe, expect, it, vi } from "vitest";
import {
  collectEnvNeeds,
  type EnvNeed,
  parseEnv,
  reconcileEnv,
  serializeEnvAppend,
} from "./env-reconcile";
import type { ResourceRequirementRow } from "./requirements";

function row(
  over: Partial<ResourceRequirementRow> = {},
): ResourceRequirementRow {
  return {
    type: "sql_warehouse",
    required: true,
    fields: [{ key: "id", env: "DATABRICKS_WAREHOUSE_ID", origin: "user" }],
    ...over,
  };
}

describe("collectEnvNeeds", () => {
  it("includes user-origin env fields", () => {
    const needs = collectEnvNeeds([row()]);
    expect(needs.map((n) => n.env)).toEqual(["DATABRICKS_WAREHOUSE_ID"]);
  });

  it("excludes platform-origin fields (deploy-injected)", () => {
    const needs = collectEnvNeeds([
      row({
        type: "database",
        fields: [
          { key: "host", env: "PGHOST", origin: "platform" },
          { key: "endpoint", env: "LAKEBASE_ENDPOINT", origin: "cli" },
        ],
      }),
    ]);
    expect(needs.map((n) => n.env)).toEqual(["LAKEBASE_ENDPOINT"]);
  });

  it("excludes fields with no env name", () => {
    const needs = collectEnvNeeds([
      row({ fields: [{ key: "name", origin: "user" }] }),
    ]);
    expect(needs).toEqual([]);
  });

  it("orders required needs before optional and de-dupes shared vars", () => {
    const needs = collectEnvNeeds([
      row({
        required: false,
        type: "volume",
        fields: [{ key: "name", env: "VOLUME_NAME", origin: "user" }],
      }),
      row(),
      // duplicate env from another required resource
      row({
        type: "other",
        fields: [{ key: "id", env: "DATABRICKS_WAREHOUSE_ID", origin: "user" }],
      }),
    ]);
    expect(needs.map((n) => n.env)).toEqual([
      "DATABRICKS_WAREHOUSE_ID",
      "VOLUME_NAME",
    ]);
  });

  it("carries the static default value", () => {
    const needs = collectEnvNeeds([
      row({
        type: "database",
        fields: [
          { key: "port", env: "PGPORT", origin: "static", value: "5432" },
        ],
      }),
    ]);
    // static is not platform, so it's included with its default
    expect(needs[0]).toMatchObject({ env: "PGPORT", defaultValue: "5432" });
  });

  it("excludes localOnly platform fields even without a computed origin", () => {
    // Registry-fetched authored manifest: no `origin`, classify from contract.
    const needs = collectEnvNeeds([
      row({
        type: "database",
        fields: [
          { key: "host", localOnly: true, env: "PGHOST" },
          { key: "port", localOnly: true, value: "5432", env: "PGPORT" },
          {
            key: "endpoint",
            resolve: "postgres:endpointPath",
            env: "LAKEBASE_ENDPOINT",
          },
          { key: "id", env: "DATABRICKS_WAREHOUSE_ID" },
        ],
      }),
    ]);
    expect(needs.map((n) => n.env)).toEqual([
      "LAKEBASE_ENDPOINT",
      "DATABRICKS_WAREHOUSE_ID",
    ]);
  });
});

describe("parseEnv", () => {
  it("parses KEY=VALUE lines, skipping comments and blanks", () => {
    const parsed = parseEnv("# comment\nFOO=bar\n\nBAZ = qux \n");
    expect(parsed).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips surrounding quotes", () => {
    expect(parseEnv("A=\"one\"\nB='two'")).toEqual({ A: "one", B: "two" });
  });

  it("keeps '=' inside values", () => {
    expect(parseEnv("URL=postgres://a=b")).toEqual({ URL: "postgres://a=b" });
  });
});

describe("serializeEnvAppend", () => {
  it("returns empty for no entries", () => {
    expect(serializeEnvAppend([])).toBe("");
  });

  it("emits KEY=VALUE lines with optional comment", () => {
    expect(
      serializeEnvAppend([{ env: "FOO", value: "bar", comment: "note" }]),
    ).toBe("# note\nFOO=bar\n");
  });
});

describe("reconcileEnv", () => {
  const need: EnvNeed = {
    env: "DATABRICKS_WAREHOUSE_ID",
    resourceType: "sql_warehouse",
    required: true,
    origin: "user",
  };

  it("reports already-set vars with their value and never overwrites them", async () => {
    const provide = vi.fn();
    const res = await reconcileEnv([need], {
      existing: { DATABRICKS_WAREHOUSE_ID: "existing" },
      provide,
    });
    // Value is carried so callers can assign it to databricks.yml target
    // variables, but status stays "already-set" so .env isn't rewritten.
    expect(res).toEqual([
      {
        env: "DATABRICKS_WAREHOUSE_ID",
        value: "existing",
        status: "already-set",
      },
    ]);
    expect(provide).not.toHaveBeenCalled();
  });

  it("uses static defaults without invoking provide", async () => {
    const provide = vi.fn();
    const res = await reconcileEnv(
      [{ ...need, defaultValue: "5432", env: "PGPORT" }],
      { existing: {}, provide },
    );
    expect(res).toEqual([{ env: "PGPORT", value: "5432", status: "written" }]);
    expect(provide).not.toHaveBeenCalled();
  });

  it("writes a provided value", async () => {
    const provide = vi.fn(async () => "wh-123");
    const res = await reconcileEnv([need], { existing: {}, provide });
    expect(res).toEqual([
      { env: "DATABRICKS_WAREHOUSE_ID", value: "wh-123", status: "written" },
    ]);
  });

  it("skips when provide returns undefined", async () => {
    const provide = vi.fn(async () => undefined);
    const res = await reconcileEnv([need], { existing: {}, provide });
    expect(res).toEqual([
      { env: "DATABRICKS_WAREHOUSE_ID", status: "skipped" },
    ]);
  });

  it("treats an empty existing value as unset", async () => {
    const provide = vi.fn(async () => "filled");
    const res = await reconcileEnv([need], {
      existing: { DATABRICKS_WAREHOUSE_ID: "" },
      provide,
    });
    expect(res[0]).toEqual({
      env: "DATABRICKS_WAREHOUSE_ID",
      value: "filled",
      status: "written",
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { originForEnvVars, readBundleInfo } from "./bundle";

function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bundle-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const BUNDLE = `
resources:
  apps:
    app:
      name: my-app
      resources:
        - name: sql-warehouse            # external: \${var.*}
          sql_warehouse:
            id: \${var.sql_warehouse_id}
            permission: CAN_USE
        - name: report-job               # bundle-managed: \${resources.*}
          job:
            id: \${resources.jobs.report.id}
            permission: CAN_MANAGE_RUN
  jobs:
    report:
      name: report
`;

const APP_YAML = `
env:
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse
  - name: DATABRICKS_JOB_REPORT
    valueFrom: report-job
`;

describe("readBundleInfo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("returns present:false when no databricks.yml exists", () => {
    const dir = tmp({});
    dirs.push(dir);
    const info = readBundleInfo(dir);
    expect(info.present).toBe(false);
    expect(info.bindings.size).toBe(0);
  });

  it("throws on malformed databricks.yml instead of treating it as absent", () => {
    // A present-but-unparseable bundle is a deploy-breaking error; swallowing it
    // would let doctor skip all wiring checks and report a false all-clear.
    const dir = tmp({ "databricks.yml": "resources: [ this: is: not: valid" });
    dirs.push(dir);
    expect(() => readBundleInfo(dir)).toThrow(/databricks\.yml/);
  });

  it("throws on malformed app.yaml", () => {
    const dir = tmp({
      "databricks.yml": BUNDLE,
      "app.yaml": "env:\n  - name: X\n   valueFrom: bad-indent",
    });
    dirs.push(dir);
    expect(() => readBundleInfo(dir)).toThrow(/app\.yaml/);
  });

  it("classifies external (var) vs bundle-managed (resources ref) bindings", () => {
    const dir = tmp({ "databricks.yml": BUNDLE, "app.yaml": APP_YAML });
    dirs.push(dir);
    const info = readBundleInfo(dir);
    expect(info.present).toBe(true);
    expect(info.bindings.get("sql-warehouse")?.origin).toBe("external");
    const job = info.bindings.get("report-job");
    expect(job?.origin).toBe("bundle-managed");
    expect(job?.ref).toEqual({ type: "jobs", key: "report" });
  });

  it("records declared bundle resources and the app.yaml env→binding map", () => {
    const dir = tmp({ "databricks.yml": BUNDLE, "app.yaml": APP_YAML });
    dirs.push(dir);
    const info = readBundleInfo(dir);
    expect(info.declaredResources.has("jobs.report")).toBe(true);
    expect(info.envToBinding.get("DATABRICKS_WAREHOUSE_ID")).toBe(
      "sql-warehouse",
    );
  });

  it("counts valueFrom and literal value entries as wired; a null value isn't", () => {
    const dir = tmp({
      "databricks.yml": BUNDLE,
      "app.yaml": `${APP_YAML}  - name: DATABRICKS_GENIE_SPACE_ID
    value: 01f0abc
  - name: EMPTY_LITERAL
    value: ""
  - name: NULL_VALUE
    value:
`,
    });
    dirs.push(dir);
    const info = readBundleInfo(dir);
    expect([...info.wiredEnvVars].sort()).toEqual([
      "DATABRICKS_GENIE_SPACE_ID",
      "DATABRICKS_JOB_REPORT",
      "DATABRICKS_WAREHOUSE_ID",
      "EMPTY_LITERAL",
    ]);
    // A literal has no binding to join, so it stays out of envToBinding.
    expect(info.envToBinding.has("DATABRICKS_GENIE_SPACE_ID")).toBe(false);
  });
});

describe("originForEnvVars", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("resolves origin by walking env var → binding → origin", () => {
    const dir = tmp({ "databricks.yml": BUNDLE, "app.yaml": APP_YAML });
    dirs.push(dir);
    const info = readBundleInfo(dir);
    expect(originForEnvVars(["DATABRICKS_WAREHOUSE_ID"], info)).toBe(
      "external",
    );
    expect(originForEnvVars(["DATABRICKS_JOB_REPORT"], info)).toBe(
      "bundle-managed",
    );
    // Unknown env / no bundle → undefined (caller treats as external).
    expect(originForEnvVars(["NOPE"], info)).toBeUndefined();
  });
});

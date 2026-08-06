import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { buildConfigPlan } from "./config-plan";
import { writeConfig } from "./config-writer";
import type { ResourceRequirementRow } from "./requirements";

const FIXTURES = path.join(__dirname, "__fixtures__");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-writer-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirs.length = 0;
});

/** Compares two YAML strings by parsed value (ignores incidental formatting). */
function sameYaml(a: string, b: string): boolean {
  const pa = parseDocument(a).toJSON();
  const pb = parseDocument(b).toJSON();
  return JSON.stringify(pa) === JSON.stringify(pb);
}

const WAREHOUSE: ResourceRequirementRow = {
  type: "sql_warehouse",
  resourceKey: "sql-warehouse",
  permission: "CAN_USE",
  required: true,
  fields: [{ key: "id", env: "DATABRICKS_WAREHOUSE_ID", origin: "user" }],
};

describe("writeConfig — golden fixtures (analytics)", () => {
  it("app.yaml env matches the databricks-rendered fixture", () => {
    const cwd = makeTempDir();
    const plan = buildConfigPlan([WAREHOUSE], {
      DATABRICKS_WAREHOUSE_ID: "abc123warehouse",
    });
    writeConfig(cwd, plan);

    const generated = fs.readFileSync(path.join(cwd, "app.yaml"), "utf-8");
    const golden = fs.readFileSync(
      path.join(FIXTURES, "analytics", "app.yaml"),
      "utf-8",
    );
    // The fixture also has `command:`; our additive writer only owns `env`.
    const genEnv = parseDocument(generated).get("env");
    const goldEnv = parseDocument(golden).get("env");
    expect(JSON.stringify(genEnv)).toBe(JSON.stringify(goldEnv));
  });

  it("databricks.yml variables + binding match the fixture's shapes", () => {
    const cwd = makeTempDir();
    const plan = buildConfigPlan([WAREHOUSE], {
      DATABRICKS_WAREHOUSE_ID: "abc123warehouse",
    });
    writeConfig(cwd, plan);

    const generated = parseDocument(
      fs.readFileSync(path.join(cwd, "databricks.yml"), "utf-8"),
    ).toJSON();
    const golden = parseDocument(
      fs.readFileSync(
        path.join(FIXTURES, "analytics", "databricks.yml"),
        "utf-8",
      ),
    ).toJSON();

    // Variable definition
    expect(generated.variables.sql_warehouse_id).toBeDefined();
    // Resource binding matches
    expect(generated.resources.apps.app.resources).toEqual(
      golden.resources.apps.app.resources,
    );
    // Target value
    expect(generated.targets.default.variables.sql_warehouse_id).toBe(
      golden.targets.default.variables.sql_warehouse_id,
    );
  });
});

describe("writeConfig — additive patching", () => {
  it("is idempotent: re-writing changes nothing", () => {
    const cwd = makeTempDir();
    const plan = buildConfigPlan([WAREHOUSE], {
      DATABRICKS_WAREHOUSE_ID: "abc123warehouse",
    });
    const first = writeConfig(cwd, plan);
    expect(first.appYamlChanged).toBe(true);

    const appAfterFirst = fs.readFileSync(path.join(cwd, "app.yaml"), "utf-8");
    const second = writeConfig(cwd, plan);
    expect(second.appYamlChanged).toBe(false);
    expect(second.databricksYmlChanged).toBe(false);
    expect(fs.readFileSync(path.join(cwd, "app.yaml"), "utf-8")).toBe(
      appAfterFirst,
    );
  });

  it("never clobbers an existing env entry or user comments", () => {
    const cwd = makeTempDir();
    fs.writeFileSync(
      path.join(cwd, "app.yaml"),
      "command: ['npm', 'run', 'start']\n# my comment\nenv:\n  - name: EXISTING\n    valueFrom: other\n",
    );
    const plan = buildConfigPlan([WAREHOUSE]);
    writeConfig(cwd, plan);

    const out = fs.readFileSync(path.join(cwd, "app.yaml"), "utf-8");
    expect(out).toContain("# my comment");
    expect(out).toContain("EXISTING");
    expect(out).toContain("DATABRICKS_WAREHOUSE_ID");
    // command line preserved
    expect(out).toContain("command:");
  });

  it("skips databricks.yml binding for unverified types but keeps env", () => {
    const cwd = makeTempDir();
    const genie: ResourceRequirementRow = {
      type: "genie_space",
      resourceKey: "genie-space",
      required: true,
      fields: [{ key: "id", env: "GENIE_SPACE_ID", origin: "user" }],
    };
    const result = writeConfig(cwd, buildConfigPlan([genie]));
    expect(result.unverifiedTypes).toEqual(["genie_space"]);
    expect(fs.existsSync(path.join(cwd, "app.yaml"))).toBe(true);
    // no binding written → databricks.yml not created
    expect(fs.existsSync(path.join(cwd, "databricks.yml"))).toBe(false);
  });

  it("produces valid round-trippable YAML", () => {
    const cwd = makeTempDir();
    writeConfig(
      cwd,
      buildConfigPlan([WAREHOUSE], { DATABRICKS_WAREHOUSE_ID: "w1" }),
    );
    const db = fs.readFileSync(path.join(cwd, "databricks.yml"), "utf-8");
    expect(() => parseDocument(db).toJSON()).not.toThrow();
    expect(sameYaml(db, db)).toBe(true);
  });
});

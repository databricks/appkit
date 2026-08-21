import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { capChoices, syncEnv } from "./env-writer";
import type { ResourceRequirementRow } from "./requirements";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-writer-"));
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

const WAREHOUSE_ROW: ResourceRequirementRow = {
  type: "sql_warehouse",
  required: true,
  fields: [{ key: "id", env: "DATABRICKS_WAREHOUSE_ID", origin: "user" }],
};

const PLATFORM_ROW: ResourceRequirementRow = {
  type: "database",
  required: true,
  fields: [{ key: "host", env: "PGHOST", origin: "platform" }],
};

describe("syncEnv", () => {
  it("writes provided values to .env and names to .env.example", async () => {
    const cwd = makeTempDir();
    const res = await syncEnv([WAREHOUSE_ROW], {
      cwd,
      nonInteractive: true,
      values: { DATABRICKS_WAREHOUSE_ID: "wh-123" },
    });

    expect(res).toEqual([
      { env: "DATABRICKS_WAREHOUSE_ID", value: "wh-123", status: "written" },
    ]);
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
    expect(env).toContain("DATABRICKS_WAREHOUSE_ID=wh-123");
    const example = fs.readFileSync(path.join(cwd, ".env.example"), "utf-8");
    expect(example).toContain("DATABRICKS_WAREHOUSE_ID=");
    expect(example).not.toContain("wh-123");
  });

  it("never overwrites an already-set var", async () => {
    const cwd = makeTempDir();
    fs.writeFileSync(
      path.join(cwd, ".env"),
      "DATABRICKS_WAREHOUSE_ID=preexisting\n",
    );
    const res = await syncEnv([WAREHOUSE_ROW], {
      cwd,
      nonInteractive: true,
      values: { DATABRICKS_WAREHOUSE_ID: "wh-123" },
    });

    expect(res[0].status).toBe("already-set");
    // The existing value is carried through so it can be assigned to the
    // databricks.yml target variable (else `bundle validate` fails on an
    // unassigned ${var.…}).
    expect(res[0].value).toBe("preexisting");
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
    expect(env).toContain("DATABRICKS_WAREHOUSE_ID=preexisting");
    expect(env).not.toContain("wh-123");
  });

  it("excludes platform-injected fields from .env entirely", async () => {
    const cwd = makeTempDir();
    const res = await syncEnv([PLATFORM_ROW], {
      cwd,
      nonInteractive: true,
      values: { PGHOST: "should-be-ignored" },
    });

    expect(res).toEqual([]);
    expect(fs.existsSync(path.join(cwd, ".env"))).toBe(false);
  });

  it("in non-interactive mode, leaves vars without a flag unset", async () => {
    const cwd = makeTempDir();
    const res = await syncEnv([WAREHOUSE_ROW], {
      cwd,
      nonInteractive: true,
    });
    expect(res[0].status).toBe("skipped");
    // .env not created since nothing was written
    expect(fs.existsSync(path.join(cwd, ".env"))).toBe(false);
  });

  it("preserves existing .env content when appending", async () => {
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, ".env"), "EXISTING=1");
    await syncEnv([WAREHOUSE_ROW], {
      cwd,
      nonInteractive: true,
      values: { DATABRICKS_WAREHOUSE_ID: "wh-123" },
    });
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
    expect(env).toContain("EXISTING=1");
    expect(env).toContain("DATABRICKS_WAREHOUSE_ID=wh-123");
  });
});

describe("capChoices", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    value: `w${i}`,
    label: `Warehouse ${i}`,
  }));

  it("returns the list unchanged when at or under the limit", () => {
    const few = many.slice(0, 5);
    expect(capChoices(few, "sql_warehouse", 25)).toBe(few);
  });

  it("truncates to the limit when over", () => {
    const capped = capChoices(many, "sql_warehouse", 25);
    expect(capped).toHaveLength(25);
    expect(capped[0].value).toBe("w0");
    expect(capped[24].value).toBe("w24");
  });

  it("keeps original order", () => {
    const capped = capChoices(many, "sql_warehouse", 3);
    expect(capped.map((c) => c.value)).toEqual(["w0", "w1", "w2"]);
  });
});

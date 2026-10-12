import { afterEach, describe, expect, test } from "vitest";

import {
  parseResourceName,
  readDeployBranches,
  readLocalTarget,
} from "../targets";
import { cleanupTempApps, databricksYml, tempApp } from "./fakes";

afterEach(cleanupTempApps);

describe("parseResourceName", () => {
  test("splits project, branch, endpoint and database names", () => {
    expect(
      parseResourceName("projects/p/branches/b/endpoints/primary"),
    ).toEqual({
      project: "projects/p",
      branch: "projects/p/branches/b",
      endpoint: "projects/p/branches/b/endpoints/primary",
    });
    expect(
      parseResourceName("projects/p/branches/b/databases/databricks-postgres"),
    ).toEqual({
      project: "projects/p",
      branch: "projects/p/branches/b",
      database: "projects/p/branches/b/databases/databricks-postgres",
    });
    expect(parseResourceName("projects/p")).toEqual({ project: "projects/p" });
  });

  test("template placeholders and junk are null", () => {
    expect(parseResourceName("your_postgres_endpointPath")).toBeNull();
    expect(parseResourceName("")).toBeNull();
    expect(parseResourceName(undefined)).toBeNull();
  });
});

describe("readLocalTarget", () => {
  test("reads the .env endpoint and this checkout's session", () => {
    expect(
      readLocalTarget({
        LAKEBASE_ENDPOINT: "projects/p/branches/b/endpoints/primary",
        PGHOST: "ep.example.com",
        APPKIT_DB_SESSION: "k2x9q0ab",
      }),
    ).toEqual({
      endpoint: "projects/p/branches/b/endpoints/primary",
      session: "k2x9q0ab",
    });
  });

  test("placeholders from .env.example read as not configured", () => {
    expect(
      readLocalTarget({
        LAKEBASE_ENDPOINT: "your_postgres_endpointPath",
        APPKIT_DB_SESSION: "NOT VALID",
      }),
    ).toEqual({ endpoint: null, session: null });
  });
});

describe("readDeployBranches", () => {
  test("reads the default target's postgres_branch", () => {
    const root = tempApp({
      "databricks.yml": databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/databricks-postgres",
      ),
    });
    expect(readDeployBranches(root)).toEqual([
      "projects/p/branches/production",
    ]);
  });

  test("every target's branch counts, and the variable's default", () => {
    const root = tempApp({
      "databricks.yml": `variables:
  postgres_branch:
    default: projects/p/branches/main
targets:
  default:
    default: true
  personal:
    variables:
      postgres_branch: projects/p/branches/dev-alice-1a2b3c
  staging:
    variables:
      postgres_branch: projects/p/branches/staging
`,
    });
    expect(readDeployBranches(root)).toEqual([
      "projects/p/branches/main",
      "projects/p/branches/dev-alice-1a2b3c",
      "projects/p/branches/staging",
    ]);
  });

  test("empty without databricks.yml or without a postgres binding", () => {
    expect(readDeployBranches(tempApp())).toEqual([]);
    expect(
      readDeployBranches(tempApp({ "databricks.yml": "bundle:\n  name: x\n" })),
    ).toEqual([]);
  });

  test("an invalid databricks.yml throws instead of reading as no binding", () => {
    const root = tempApp({ "databricks.yml": "targets:\n  default: [\n" });
    expect(() => readDeployBranches(root)).toThrow(
      /^Cannot read databricks\.yml, so the branches it deploys to are unknown: .+\(\d+:\d+\)$/,
    );
  });
});

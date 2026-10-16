import { afterEach, describe, expect, test } from "vitest";

import {
  parseProject,
  parseResourceName,
  readDeployBranches,
  readDeployTarget,
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

describe("parseProject", () => {
  test("accepts projects/<id> or a bare <id>, normalized to the resource name", () => {
    expect(parseProject("projects/my-app")).toBe("projects/my-app");
    expect(parseProject(" my-app ")).toBe("projects/my-app");
  });

  test("placeholders, branch paths and junk are null", () => {
    expect(parseProject("your_postgres_project")).toBeNull();
    expect(parseProject("projects/p/branches/b")).toBeNull();
    expect(parseProject("")).toBeNull();
    expect(parseProject(undefined)).toBeNull();
  });
});

describe("readLocalTarget", () => {
  test("reads a real .env target", () => {
    expect(
      readLocalTarget({
        LAKEBASE_PROJECT: "p",
        LAKEBASE_ENDPOINT: "projects/p/branches/b/endpoints/primary",
        PGHOST: "ep.example.com",
        PGDATABASE: "databricks_postgres",
        PGUSER: "alice@example.com",
        APPKIT_DB_SESSION: "k2x9q0ab",
      }),
    ).toEqual({
      project: "projects/p",
      endpoint: "projects/p/branches/b/endpoints/primary",
      database: "databricks_postgres",
      session: "k2x9q0ab",
    });
  });

  test("placeholders from .env.example read as not configured", () => {
    expect(
      readLocalTarget({
        LAKEBASE_PROJECT: "your_postgres_project",
        LAKEBASE_ENDPOINT: "your_postgres_endpointPath",
        PGHOST: "your_postgres_host",
        PGDATABASE: "your_postgres_databaseName",
        APPKIT_DB_SESSION: "NOT VALID",
      }),
    ).toEqual({
      project: null,
      endpoint: null,
      database: null,
      session: null,
    });
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

describe("readDeployTarget", () => {
  test("reads the default target's postgres variables and the app name", () => {
    const root = tempApp({
      "databricks.yml": databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/databricks-postgres",
      ),
    });
    expect(readDeployTarget(root)).toEqual({
      branch: "projects/p/branches/production",
      database: "projects/p/branches/production/databases/databricks-postgres",
      appName: "my-app",
    });
  });

  test("falls back to top-level variable defaults", () => {
    const root = tempApp({
      "databricks.yml": `variables:
  postgres_branch:
    default: projects/p/branches/main
targets:
  dev:
    default: true
`,
    });
    expect(readDeployTarget(root)).toEqual({
      branch: "projects/p/branches/main",
      database: null,
      appName: null,
    });
  });

  test("the default target's app name overrides the top-level one", () => {
    const root = tempApp({
      // Appended under targets.default.
      "databricks.yml": `${databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/databricks-postgres",
      )}    resources:\n      apps:\n        app:\n          name: my-app-prod\n`,
    });
    expect(readDeployTarget(root)?.appName).toBe("my-app-prod");
  });

  test("null without databricks.yml or without a postgres binding", () => {
    expect(readDeployTarget(tempApp())).toBeNull();
    expect(
      readDeployTarget(tempApp({ "databricks.yml": "bundle:\n  name: x\n" })),
    ).toBeNull();
  });
});

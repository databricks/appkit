import { afterEach, describe, expect, test } from "vitest";

import {
  parseResourceName,
  readDeployBoundary,
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

describe("readDeployBoundary", () => {
  test("reads the default target's postgres resource and postgres_branch", () => {
    const root = tempApp({
      "databricks.yml": databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/databricks-postgres",
      ),
    });
    expect(readDeployBoundary(root)).toEqual({
      branches: new Set(["projects/p/branches/production"]),
      unresolved: [],
    });
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
    expect(readDeployBoundary(root).branches).toEqual(
      new Set([
        "projects/p/branches/main",
        "projects/p/branches/dev-alice-1a2b3c",
        "projects/p/branches/staging",
      ]),
    );
  });

  test("every postgres resource of every app counts, in an included file too", () => {
    const root = tempApp({
      "databricks.yml": `include:
  - resources/*.yml
resources:
  apps:
    app:
      resources:
        - name: postgres
          postgres:
            branch: projects/p/branches/production
        - name: archive
          postgres:
            branch: projects/p/branches/archive
`,
      "resources/reports.yml": `resources:
  apps:
    reports:
      resources:
        - name: postgres
          postgres:
            branch: projects/p/branches/reports
            database: projects/p/branches/reports/databases/db
`,
    });
    expect(readDeployBoundary(root)).toEqual({
      branches: new Set([
        "projects/p/branches/production",
        "projects/p/branches/archive",
        "projects/p/branches/reports",
      ]),
      unresolved: [],
    });
  });

  test("a target that gives a declared variable no value leaves its references unresolved", () => {
    const root = tempApp({
      "databricks.yml": `${databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/db",
      )}  prod: {}
`,
    });
    expect(readDeployBoundary(root)).toEqual({
      branches: new Set(["projects/p/branches/production"]),
      unresolved: [
        {
          target: "prod",
          at: "resources.apps.app.resources[0].postgres.branch",
          written: "${var.postgres_branch}",
        },
        {
          target: "prod",
          at: "resources.apps.app.resources[0].postgres.database",
          written: "${var.postgres_database}",
        },
        { target: "prod", at: "variables.postgres_branch", written: "" },
      ],
    });
  });

  test("a reference only a deploy resolves, or a value that is not a branch, is unresolved", () => {
    const root = tempApp({
      "databricks.yml": `resources:
  apps:
    app:
      resources:
        - name: postgres
          postgres:
            branch: projects/p/branches/dev-\${workspace.current_user.short_name}
        - name: other
          postgres:
            branch: main
`,
    });
    expect(readDeployBoundary(root)).toEqual({
      branches: new Set(),
      unresolved: [
        {
          target: "default",
          at: "resources.apps.app.resources[0].postgres.branch",
          written:
            "projects/p/branches/dev-${workspace.current_user.short_name}",
        },
        {
          target: "default",
          at: "resources.apps.app.resources[1].postgres.branch",
          written: "main",
        },
      ],
    });
  });

  test("empty without databricks.yml or without a postgres binding", () => {
    const empty = { branches: new Set(), unresolved: [] };
    expect(readDeployBoundary(tempApp())).toEqual(empty);
    expect(
      readDeployBoundary(tempApp({ "databricks.yml": "bundle:\n  name: x\n" })),
    ).toEqual(empty);
  });

  test("an invalid databricks.yml throws instead of reading as no binding", () => {
    const root = tempApp({ "databricks.yml": "targets:\n  default: [\n" });
    expect(() => readDeployBoundary(root)).toThrow(
      /^Cannot read databricks\.yml, so the branches it deploys to are unknown: .+\(\d+:\d+\)$/,
    );
  });
});

import { afterEach, describe, expect, test } from "vitest";

import { classifyBranch } from "../guard";
import { devBranchId } from "../naming";
import {
  parseProject,
  parseResourceName,
  readDeployBoundary,
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

  test("an include pattern with glob syntax beyond * and ? throws instead of matching nothing", () => {
    const root = tempApp({
      "databricks.yml": "include:\n  - resources/[ab]*.yml\n",
      "resources/app.yml": `resources:
  apps:
    app:
      resources:
        - name: postgres
          postgres:
            branch: projects/p/branches/production
`,
    });
    expect(() => readDeployBoundary(root)).toThrow(
      'Cannot read include pattern "resources/[ab]*.yml", so the branches it deploys to are unknown: only * and ? are supported, not [, ] or \\.',
    );
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

  test("a variable-overrides.json value binds its target too, so the dev branch it names is a deploy target", () => {
    const dev = `projects/p/branches/${devBranchId("alice@example.com")}`;
    const root = tempApp({
      "databricks.yml": databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/db",
      ),
      ".databricks/bundle/default/variable-overrides.json": JSON.stringify({
        postgres_branch: dev,
        postgres_database: `${dev}/databases/db`,
      }),
    });

    const boundary = readDeployBoundary(root);

    expect(boundary).toEqual({
      branches: new Set(["projects/p/branches/production", dev]),
      unresolved: [],
    });
    expect(
      classifyBranch({
        branch: { name: dev, status: {} },
        userName: "alice@example.com",
        sessionId: null,
        boundary,
      }),
    ).toEqual({
      kind: "deploy-target",
      reason: "it is a branch databricks.yml deploys to",
    });
  });

  test("a variable-overrides.json value that is not a branch name is unresolved, and names the file", () => {
    const root = tempApp({
      "databricks.yml": databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/db",
      ),
      ".databricks/bundle/default/variable-overrides.json": JSON.stringify({
        postgres_branch: { lookup: { name: "dev" } },
      }),
    });

    expect(readDeployBoundary(root).unresolved).toEqual([
      {
        target: "default",
        at: "resources.apps.app.resources[0].postgres.branch",
        written: "${var.postgres_branch}",
        file: ".databricks/bundle/default/variable-overrides.json",
      },
      {
        target: "default",
        at: "variables.postgres_branch",
        written: "",
        file: ".databricks/bundle/default/variable-overrides.json",
      },
    ]);
  });

  test.each([
    [
      "{",
      /^Cannot read \.databricks\/bundle\/default\/variable-overrides\.json, so the branches it deploys to are unknown: .+/,
    ],
    [
      "[]",
      /^Cannot read \.databricks\/bundle\/default\/variable-overrides\.json, so the branches it deploys to are unknown: it is not a JSON object$/,
    ],
  ])(
    "a variable-overrides.json of %s throws instead of reading as no override",
    (contents, message) => {
      const root = tempApp({
        "databricks.yml": databricksYml(
          "projects/p/branches/production",
          "projects/p/branches/production/databases/db",
        ),
        ".databricks/bundle/default/variable-overrides.json": contents,
      });
      expect(() => readDeployBoundary(root)).toThrow(message);
    },
  );

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

describe("readDeployTarget", () => {
  test("reads the default target's postgres variables", () => {
    const root = tempApp({
      "databricks.yml": databricksYml(
        "projects/p/branches/production",
        "projects/p/branches/production/databases/databricks-postgres",
      ),
    });
    expect(readDeployTarget(root)).toEqual({
      branch: "projects/p/branches/production",
      database: "projects/p/branches/production/databases/databricks-postgres",
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
    });
  });

  test("null without databricks.yml or without a postgres binding", () => {
    expect(readDeployTarget(tempApp())).toBeNull();
    expect(
      readDeployTarget(tempApp({ "databricks.yml": "bundle:\n  name: x\n" })),
    ).toBeNull();
  });
});

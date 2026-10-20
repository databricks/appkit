import { afterEach, describe, expect, test } from "vitest";

import {
  parseProject,
  parseResourceName,
  readBundle,
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

  test("a branch set on an app's postgres resource counts, in an included file too", () => {
    const root = tempApp({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/app.yml": `resources:
  apps:
    app:
      name: shop
      resources:
        - name: postgres
          postgres:
            branch: projects/p/branches/production
`,
    });
    expect(readDeployBranches(root)).toEqual([
      "projects/p/branches/production",
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
  test("reads the default target's postgres resource", () => {
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

  test("null without databricks.yml, a default target or a postgres binding", () => {
    expect(readDeployTarget(tempApp())).toBeNull();
    expect(
      readDeployTarget(tempApp({ "databricks.yml": "bundle:\n  name: x\n" })),
    ).toBeNull();
    expect(
      readDeployTarget(
        tempApp({
          "databricks.yml": `variables:
  postgres_branch:
    default: projects/p/branches/main
targets:
  dev: {}
  prod: {}
`,
        }),
      ),
    ).toBeNull();
  });
});

describe("readBundle", () => {
  test("resolves each target's app, postgres resource and host from its variables", () => {
    const root = tempApp({
      "databricks.yml": `bundle:
  name: shop
variables:
  postgres_branch:
    default: projects/p/branches/main
  postgres_database:
    default: projects/p/branches/main/databases/db
  suffix:
    default: dev
workspace:
  host: https://dev.cloud.databricks.com
resources:
  apps:
    app:
      name: \${bundle.name}-\${var.suffix}
      resources:
        - name: postgres
          postgres:
            branch: \${var.postgres_branch}
            database: \${var.postgres_database}
targets:
  default:
    default: true
  prod:
    workspace:
      host: https://prod.cloud.databricks.com
    variables:
      suffix: \${bundle.target}
      postgres_branch: projects/p/branches/production
      postgres_database: projects/p/branches/production/databases/db
`,
    });

    expect(readBundle(root)).toEqual({
      file: "databricks.yml",
      targets: [
        {
          name: "default",
          isDefault: true,
          host: "https://dev.cloud.databricks.com",
          apps: [
            {
              key: "app",
              declaredName: "${bundle.name}-${var.suffix}",
              name: "shop-dev",
              postgres: {
                branch: "projects/p/branches/main",
                database: "projects/p/branches/main/databases/db",
              },
            },
          ],
          postgresBranch: "projects/p/branches/main",
          postgresDatabase: "projects/p/branches/main/databases/db",
        },
        {
          name: "prod",
          isDefault: false,
          host: "https://prod.cloud.databricks.com",
          apps: [
            {
              key: "app",
              declaredName: "${bundle.name}-${var.suffix}",
              name: "shop-prod",
              postgres: {
                branch: "projects/p/branches/production",
                database: "projects/p/branches/production/databases/db",
              },
            },
          ],
          postgresBranch: "projects/p/branches/production",
          postgresDatabase: "projects/p/branches/production/databases/db",
        },
      ],
    });
  });

  test("follows include:, and a target's app override merges resources by name", () => {
    const root = tempApp({
      "databricks.yml": `include:
  - resources/*.yml
targets:
  default:
    default: true
    resources:
      apps:
        app:
          resources:
            - name: postgres
              postgres:
                branch: projects/p/branches/production
`,
      "resources/app.yml": `resources:
  apps:
    app:
      name: shop
      resources:
        - name: warehouse
          sql_warehouse:
            id: w
        - name: postgres
          postgres:
            branch: projects/p/branches/main
            database: projects/p/branches/main/databases/db
`,
      "resources/notes.txt": "not yaml: [",
    });

    const [target] = readBundle(root)?.targets ?? [];
    expect(target?.apps).toEqual([
      {
        key: "app",
        declaredName: "shop",
        name: "shop",
        postgres: {
          branch: "projects/p/branches/production",
          database: "projects/p/branches/main/databases/db",
        },
      },
    ]);
  });

  test("a reference only a deploy resolves reads as null; no targets is one default target", () => {
    const root = tempApp({
      "databricks.yml": `variables:
  warehouse:
    lookup:
      warehouse: Shared
resources:
  apps:
    app:
      name: shop-\${workspace.current_user.short_name}
`,
    });
    expect(readBundle(root)?.targets).toEqual([
      {
        name: "default",
        isDefault: true,
        host: null,
        apps: [
          {
            key: "app",
            declaredName: "shop-${workspace.current_user.short_name}",
            name: null,
            postgres: null,
          },
        ],
        postgresBranch: null,
        postgresDatabase: null,
      },
    ]);
  });

  test("an invalid included file throws, naming it", () => {
    const root = tempApp({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/app.yml": "resources: [\n",
    });
    expect(() => readBundle(root)).toThrow(/^Cannot read app\.yml, /);
  });
});

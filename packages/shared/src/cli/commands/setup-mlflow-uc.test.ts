import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, test } from "vitest";
import {
  buildMlflowProvisionCommand,
  projectRequiresMlflowUc,
  provisionAndPersistMlflowUc,
} from "./setup";

const EXPECTED_VALUES = {
  MLFLOW_EXPERIMENT_ID: "123456789",
  MLFLOW_TRACING_SQL_WAREHOUSE_ID: "0123456789abcdef",
  MLFLOW_UC_CATALOG: "main",
  MLFLOW_UC_SCHEMA: "agent_traces",
  MLFLOW_UC_TABLE_PREFIX: "appkit",
  MLFLOW_OTEL_SPANS_TABLE: "main.agent_traces.appkit_otel_spans",
};

function createProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "appkit-mlflow-uc-"));
  mkdirSync(join(cwd, ".databricks"), { recursive: true });
  writeFileSync(
    join(cwd, "appkit.plugins.json"),
    JSON.stringify({
      plugins: { agents: { requiredByTemplate: true }, serving: {} },
    }),
  );
  writeFileSync(join(cwd, ".env"), "DATABRICKS_CONFIG_PROFILE=DEFAULT\n");
  writeFileSync(
    join(cwd, "app.yaml"),
    [
      "command: ['npm', 'run', 'start']",
      "env:",
      "  - name: MLFLOW_EXPERIMENT_ID",
      "    valueFrom: mlflow-experiment",
      "  - name: MLFLOW_TRACING_SQL_WAREHOUSE_ID",
      "    valueFrom: mlflow-tracing-warehouse",
      "  - name: MLFLOW_UC_CATALOG",
      "    value: main",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "databricks.yml"),
    [
      "bundle:",
      "  name: traced-app",
      "variables:",
      "  mlflow_experiment_id:",
      "    description: MLflow experiment ID",
      "  mlflow_tracing_warehouse_id:",
      "    description: MLflow tracing warehouse ID",
      "targets:",
      "  default:",
      "    variables:",
      "      mlflow_experiment_id: placeholder",
      "      mlflow_tracing_warehouse_id: placeholder",
      "",
    ].join("\n"),
  );
  return cwd;
}

describe("MLflow UC setup", () => {
  test("agent-enabled projects require UC tracing setup", () => {
    const cwd = createProject();

    expect(projectRequiresMlflowUc(cwd, false)).toBe(true);
  });

  test("builds the supported pinned provisioning invocation", () => {
    expect(
      buildMlflowProvisionCommand({
        cwd: "/workspace/traced-app",
        scriptPath:
          "/workspace/traced-app/node_modules/@databricks/appkit/scripts/provision-mlflow-uc.py",
        profile: "DEFAULT",
        experimentName: "/Users/user@example.com/appkit-agent-traces",
        catalog: "main",
        schema: "agent_traces",
        tablePrefix: "appkit",
        warehouseId: "0123456789abcdef",
      }),
    ).toEqual([
      "uv",
      "run",
      "--no-project",
      "--with",
      "mlflow[databricks]>=3.14.0,<4",
      "python",
      "/workspace/traced-app/node_modules/@databricks/appkit/scripts/provision-mlflow-uc.py",
      "--profile",
      "DEFAULT",
      "--experiment-name",
      "/Users/user@example.com/appkit-agent-traces",
      "--catalog",
      "main",
      "--schema",
      "agent_traces",
      "--table-prefix",
      "appkit",
      "--warehouse-id",
      "0123456789abcdef",
      "--output-json",
      "/workspace/traced-app/.databricks/mlflow-uc.json",
    ]);
  });

  test("persists all tracing values for local and deployed runtimes", async () => {
    const cwd = createProject();
    const logged: string[] = [];
    writeFileSync(
      join(cwd, ".env"),
      [
        "DATABRICKS_CONFIG_PROFILE=DEFAULT",
        "DATABRICKS_HOST=https://stale.example.com",
        "DATABRICKS_HOST=https://duplicate.example.com",
        "",
      ].join("\n"),
    );

    const result = await provisionAndPersistMlflowUc(
      {
        cwd,
        profile: "DEFAULT",
        experimentName: "/Users/user@example.com/appkit-agent-traces",
        catalog: "main",
        schema: "agent_traces",
        tablePrefix: "appkit",
        warehouseId: "0123456789abcdef",
      },
      {
        scriptPath: join(cwd, "provision-mlflow-uc.py"),
        run(command) {
          const outputPath = command[command.indexOf("--output-json") + 1];
          writeFileSync(outputPath, JSON.stringify(EXPECTED_VALUES));
          return 0;
        },
        log(message) {
          logged.push(message);
        },
        workspaceHost: "https://example.cloud.databricks.com",
      },
    );

    expect(result).toEqual(EXPECTED_VALUES);
    const dotenv = readFileSync(join(cwd, ".env"), "utf8");
    for (const [name, value] of Object.entries(EXPECTED_VALUES)) {
      expect(dotenv).toContain(`${name}=${value}`);
    }
    expect(dotenv.match(/^DATABRICKS_HOST=/gm)).toHaveLength(1);
    expect(dotenv).toContain(
      "DATABRICKS_HOST=https://example.cloud.databricks.com",
    );
    const appYaml = yaml.load(readFileSync(join(cwd, "app.yaml"), "utf8")) as {
      env: Array<{ name: string; value?: string; valueFrom?: string }>;
    };
    expect(appYaml.env).toEqual(
      expect.arrayContaining([
        {
          name: "MLFLOW_EXPERIMENT_ID",
          valueFrom: "mlflow-experiment",
        },
        {
          name: "MLFLOW_TRACING_SQL_WAREHOUSE_ID",
          valueFrom: "mlflow-tracing-warehouse",
        },
        ...Object.entries(EXPECTED_VALUES)
          .filter(
            ([name]) =>
              name !== "MLFLOW_EXPERIMENT_ID" &&
              name !== "MLFLOW_TRACING_SQL_WAREHOUSE_ID",
          )
          .map(([name, value]) => ({ name, value })),
      ]),
    );
    const bundle = yaml.load(
      readFileSync(join(cwd, "databricks.yml"), "utf8"),
    ) as {
      variables: Record<string, { default?: string }>;
      targets: { default: { variables: Record<string, string> } };
    };
    expect(bundle.variables.mlflow_experiment_id.default).toBe("123456789");
    expect(bundle.variables.mlflow_tracing_warehouse_id.default).toBe(
      "0123456789abcdef",
    );
    expect(bundle.targets.default.variables).toMatchObject({
      mlflow_experiment_id: "123456789",
      mlflow_tracing_warehouse_id: "0123456789abcdef",
    });
    expect(logged).toContain(
      "MLflow experiment: https://example.cloud.databricks.com/ml/experiments/123456789/traces",
    );
  });
});

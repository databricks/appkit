import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { beforeAll, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const outputDir = mkdtempSync(join(tmpdir(), "appkit-traced-templates-"));

describe("generated AppKit agent templates", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["generate:app-templates"], {
      cwd: root,
      env: { ...process.env, APP_TEMPLATES_OUTPUT_DIR: outputDir },
      stdio: "pipe",
    });
  }, 120_000);

  test.each(["appkit-agents", "appkit-all-in-one"])(
    "%s contains the runnable composed agent example",
    (name) => {
      const app = join(outputDir, name);
      expect(
        readFileSync(join(app, "config/agents/planner/agent.md"), "utf8"),
      ).toContain("single MLflow trace");
      expect(
        readFileSync(join(app, "server/agents/helper.ts"), "utf8"),
      ).toContain("AGENT → TOOL → AGENT → TOOL");
      expect(readFileSync(join(app, "server/server.ts"), "utf8")).toContain(
        "agents: { helper }",
      );
    },
  );

  test.each(["appkit-agents", "appkit-all-in-one"])(
    "%s persists all UC tracing configuration and resources",
    (name) => {
      const app = join(outputDir, name);
      const appYaml = yaml.load(
        readFileSync(join(app, "app.yaml"), "utf8"),
      ) as { env: Array<{ name: string; value?: string; valueFrom?: string }> };
      const generated = [
        readFileSync(join(app, "app.yaml"), "utf8"),
        readFileSync(join(app, "databricks.yml"), "utf8"),
        readFileSync(join(app, ".env.tmpl"), "utf8"),
      ].join("\n");
      for (const variable of [
        "MLFLOW_EXPERIMENT_ID",
        "MLFLOW_TRACING_SQL_WAREHOUSE_ID",
        "MLFLOW_UC_CATALOG",
        "MLFLOW_UC_SCHEMA",
        "MLFLOW_UC_TABLE_PREFIX",
        "MLFLOW_OTEL_SPANS_TABLE",
      ]) {
        expect(generated).toContain(variable);
      }
      const manifest = JSON.parse(
        readFileSync(join(app, "appkit.plugins.json"), "utf8"),
      );
      expect(manifest.plugins.agents.requiredByTemplate).toBe(true);
      expect(
        manifest.plugins.agents.resources.required.map(
          (resource: { resourceKey: string }) => resource.resourceKey,
        ),
      ).toEqual(["mlflow-experiment", "mlflow-tracing-warehouse"]);
      expect(appYaml.env).toEqual(
        expect.arrayContaining([
          { name: "MLFLOW_UC_CATALOG", value: "main" },
          { name: "MLFLOW_UC_SCHEMA", value: "agent_traces" },
          { name: "MLFLOW_UC_TABLE_PREFIX", value: "appkit" },
          {
            name: "MLFLOW_OTEL_SPANS_TABLE",
            value: "main.agent_traces.appkit_otel_spans",
          },
        ]),
      );
      for (const entry of appYaml.env.filter(
        (item) =>
          item.name.startsWith("MLFLOW_UC_") ||
          item.name === "MLFLOW_OTEL_SPANS_TABLE",
      )) {
        expect(entry.valueFrom).toBeUndefined();
      }
      const packageJson = JSON.parse(
        readFileSync(join(app, "package.json"), "utf8"),
      );
      expect(packageJson.scripts.setup).toBe(
        "appkit setup --write --mlflow-uc",
      );
      expect(packageJson.dependencies["@databricks/appkit"]).toBe("0.59.0");
      expect(packageJson.dependencies["@databricks/appkit-ui"]).toBe("0.59.0");
      expect(existsSync(join(app, "package-lock.json"))).toBe(false);
    },
  );

  test("generated agent UI exposes the direct MLflow trace link", () => {
    const chat = readFileSync(
      join(outputDir, "appkit-agents/client/src/pages/agents/AgentChat.tsx"),
      "utf8",
    );
    expect(chat).toContain("Open trace in MLflow");
    expect(chat).toContain("mlflowTraceUrl");
    expect(chat).toContain("{mlflowTraceId && (");
    expect(chat).toContain("{mlflowTraceUrl && (");
  });

  test.each(["appkit-agents", "appkit-all-in-one"])(
    "%s keeps the agent model endpoint distinct from serving",
    (name) => {
      const app = join(outputDir, name);
      const appYaml = yaml.load(
        readFileSync(join(app, "app.yaml"), "utf8"),
      ) as { env: Array<{ name: string; valueFrom?: string }> };
      const envNames = appYaml.env.map((entry) => entry.name);
      expect(new Set(envNames).size).toBe(envNames.length);
      expect(appYaml.env).toContainEqual({
        name: "DATABRICKS_AGENT_SERVING_ENDPOINT_NAME",
        valueFrom: "agents-serving-endpoint",
      });
      expect(readFileSync(join(app, "server/server.ts"), "utf8")).toContain(
        "defaultModel: process.env.DATABRICKS_AGENT_SERVING_ENDPOINT_NAME",
      );
    },
  );
});

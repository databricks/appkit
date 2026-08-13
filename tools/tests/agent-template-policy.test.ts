import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const output = mkdtempSync(join(tmpdir(), "appkit-agent-policy-"));
const requiredTraceEnvironment = [
  "MLFLOW_EXPERIMENT_ID",
  "MLFLOW_TRACING_SQL_WAREHOUSE_ID",
  "MLFLOW_UC_CATALOG",
  "MLFLOW_UC_SCHEMA",
  "MLFLOW_UC_TABLE_PREFIX",
  "MLFLOW_OTEL_SPANS_TABLE",
];

interface GeneratedCandidate {
  name: string;
  directory: string;
}

function discoverGeneratedAgentTemplates(): GeneratedCandidate[] {
  return readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, directory: join(output, entry.name) }))
    .filter(({ directory }) => {
      const server = readFileSync(join(directory, "server/server.ts"), "utf8");
      return /\bagents\s*\(/.test(server) || /agents:\s*\{/.test(server);
    });
}

describe("behavior-discovered generated agent template policy", () => {
  beforeAll(() => {
    const compatibleCli = "/tmp/databricks-cli-1.11.0/databricks";
    execFileSync("pnpm", ["generate:app-templates"], {
      cwd: root,
      env: {
        ...process.env,
        APP_TEMPLATES_OUTPUT_DIR: output,
        ...(process.env.DATABRICKS_CLI
          ? {}
          : existsSync(compatibleCli)
            ? { DATABRICKS_CLI: compatibleCli }
            : {}),
      },
      stdio: "pipe",
    });
  }, 120_000);

  afterAll(() => rmSync(output, { recursive: true, force: true }));

  test("discovers agent surfaces from generated runtime behavior", () => {
    const candidates = discoverGeneratedAgentTemplates();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map(({ name }) => name).sort()).toEqual([
      "appkit-agents",
      "appkit-all-in-one",
    ]);
  });

  test("every discovered surface declares immutable UC trace resources", () => {
    for (const candidate of discoverGeneratedAgentTemplates()) {
      const app = yaml.load(
        readFileSync(join(candidate.directory, "app.yaml"), "utf8"),
      ) as { env: Array<{ name: string; value?: string; valueFrom?: string }> };
      const names = app.env.map((entry) => entry.name);
      expect(names, candidate.name).toEqual(
        expect.arrayContaining(requiredTraceEnvironment),
      );
      const manifest = JSON.parse(
        readFileSync(join(candidate.directory, "appkit.plugins.json"), "utf8"),
      );
      const resources = manifest.plugins.agents.resources.required.map(
        (resource: { type: string; resourceKey: string }) => ({
          type: resource.type,
          resourceKey: resource.resourceKey,
        }),
      );
      expect(resources, candidate.name).toEqual([
        { type: "experiment", resourceKey: "mlflow-experiment" },
        {
          type: "sql_warehouse",
          resourceKey: "mlflow-tracing-warehouse",
        },
      ]);
      const staticValues = Object.fromEntries(
        app.env
          .filter((entry) => entry.name.startsWith("MLFLOW_UC_"))
          .map((entry) => [entry.name, entry.value]),
      );
      expect(staticValues, candidate.name).toEqual({
        MLFLOW_UC_CATALOG: "main",
        MLFLOW_UC_SCHEMA: "agent_traces",
        MLFLOW_UC_TABLE_PREFIX: "appkit",
      });
      expect(
        app.env.find((entry) => entry.name === "MLFLOW_OTEL_SPANS_TABLE")
          ?.value,
        candidate.name,
      ).toBe("main.agent_traces.appkit_otel_spans");
    }
  });

  test("a newly generated behavioral agent cannot bypass the same policy", () => {
    for (const candidate of discoverGeneratedAgentTemplates()) {
      const packageJson = JSON.parse(
        readFileSync(join(candidate.directory, "package.json"), "utf8"),
      );
      expect(packageJson.scripts.setup, candidate.name).toBe(
        "appkit setup --write --mlflow-uc",
      );
      expect(
        packageJson.dependencies["@databricks/appkit"],
        candidate.name,
      ).toBe("0.59.0");
    }
  });
});

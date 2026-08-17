import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const output = mkdtempSync(join(root, ".appkit-agent-policy-"));
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

function discoverGeneratedAgentTemplates(
  searchRoot = output,
): GeneratedCandidate[] {
  const behaviorSignals = [
    /\bAgentServer\b/,
    /\b(?:createAgent|agents)\s*\(/,
    /agents:\s*\{/,
    /\/(?:invocations|responses|api\/agents)\b/,
    /(?:for\s+await|while\s*\()[\s\S]*?\bmodel\b[\s\S]*?\b(?:tool|executeTool)\b/i,
    /\b(?:retriev|vectorSearch)\w*[\s\S]*?\b(?:generat|model)\w*/i,
  ];
  return readdirSync(searchRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      directory: join(searchRoot, entry.name),
    }))
    .filter(({ directory }) => {
      const sources = readdirSync(directory, {
        recursive: true,
        encoding: "utf8",
      })
        .filter(
          (relative) =>
            !relative.includes("node_modules/") &&
            /\.(?:ts|tsx|js|jsx|py)$/.test(relative),
        )
        .map((relative) => readFileSync(join(directory, relative), "utf8"));
      return behaviorSignals.some((signal) =>
        sources.some((source) => signal.test(source)),
      );
    })
    .sort((left, right) => left.name.localeCompare(right.name));
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

  test("admits arbitrary candidates from every behavior signal even without proof", () => {
    const fixtures = mkdtempSync(join(tmpdir(), "appkit-agent-signals-"));
    const signals = new Map([
      ["odd-server", "const app = new AgentServer();"],
      ["unusual-constructor", "export const worker = createAgent({});"],
      ["endpoint-client", 'fetch("/invocations", { method: "POST" });'],
      [
        "loop-surface",
        "for await (const event of model.run()) { await executeTool(event); }",
      ],
      [
        "rag-surface",
        "const docs = await vectorSearch.query(); await model.generate(docs);",
      ],
    ]);
    try {
      for (const [name, source] of signals) {
        const serverDirectory = join(fixtures, name, "server");
        mkdirSync(serverDirectory, { recursive: true });
        writeFileSync(join(serverDirectory, "server.ts"), source);
      }
      const plainDirectory = join(fixtures, "plain-web", "server");
      mkdirSync(plainDirectory, { recursive: true });
      writeFileSync(
        join(plainDirectory, "server.ts"),
        "createApp({ plugins: [] });",
      );

      expect(
        discoverGeneratedAgentTemplates(fixtures).map(({ name }) => name),
      ).toEqual([...signals.keys()].sort());
    } finally {
      rmSync(fixtures, { recursive: true, force: true });
    }
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
      ).toBe("0.60.0");
      expect(
        packageJson.dependencies["@mlflow/core"],
        `${candidate.name} must keep AppKit as its sole tracing provider`,
      ).toBeUndefined();
    }
  });

  test("every discovered surface exposes its generated server as executable proof", () => {
    for (const candidate of discoverGeneratedAgentTemplates()) {
      const serverSource = readFileSync(
        join(candidate.directory, "server/server.ts"),
        "utf8",
      );
      expect(serverSource, candidate.name).toContain(
        "export const app = createApp({",
      );

      const requireFromGeneratedPackage = createRequire(
        join(candidate.directory, "package.json"),
      );
      expect(
        requireFromGeneratedPackage.resolve("@databricks/appkit/package.json"),
        `${candidate.name} must execute against its generated package resolution`,
      ).toBe(join(root, "packages/appkit/package.json"));
    }
  });
});

import fs from "node:fs";
import { Command, Option } from "commander";

interface EvalRunSummary {
  results: unknown[];
  mlflow?: {
    runId: string;
    report: {
      written: number;
      skipped: number;
      failures: Array<{ traceId: string; status?: number; error?: string }>;
    };
    finish: { finished: boolean; metricsError?: string; finishError?: string };
  };
}

type EvalProgress =
  | { type: "discovered"; total: number }
  | { type: "run-created"; runId: string }
  | { type: "start"; id: string; index: number; total: number }
  | { type: "result"; result: unknown; index: number; total: number };

/** Subset of `@databricks/appkit/beta`'s eval runner used by this command. */
interface EvalRunner {
  runEvalsInDir(opts: {
    rootDir?: string;
    baseUrl: string;
    filter?: string;
    tags?: string[];
    strict?: boolean;
    headers?: Record<string, string>;
    mlflow?: { host: string; token: string; experimentId: string };
    judge?: { host: string; token: string; model: string };
    workspaceClient?: unknown;
    warehouseId?: string;
    maxConcurrency?: number;
    timeoutMs?: number;
    retries?: number;
    onEvent?: (event: EvalProgress) => void;
  }): Promise<EvalRunSummary>;
  resolveDatabricksAuth(opts: {
    profile?: string;
    host?: string;
    token?: string;
  }): Promise<{ host: string; token: string } | undefined>;
  resolveWorkspaceClient(opts: {
    profile?: string;
    host?: string;
    token?: string;
  }): unknown;
  evalGlyph(result: unknown): string;
  formatEvalDetail(result: unknown): string[];
  formatSummaryLine(results: unknown[]): string;
  formatResultsJson(results: unknown[]): string;
  formatResultsJUnit(results: unknown[]): string;
  summarize(results: unknown[]): { allPassed: boolean; passRate: number };
}

/**
 * Loaded at runtime from the consuming project so this command (which ships in
 * `@databricks/shared`) doesn't take a build-time dependency on appkit. The
 * specifier is a variable so the type checker treats it as `any`.
 */
async function loadRunner(): Promise<EvalRunner> {
  const spec = "@databricks/appkit/beta";
  try {
    return (await import(spec)) as unknown as EvalRunner;
  } catch (err) {
    throw new Error(
      "Could not load @databricks/appkit. Run `appkit agent eval` from a " +
        "project with @databricks/appkit installed. " +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf(":");
    if (i === -1) continue;
    headers[v.slice(0, i).trim()] = v.slice(i + 1).trim();
  }
  return headers;
}

interface EvalOptions {
  url: string;
  strict?: boolean;
  root?: string;
  header?: string[];
  tag?: string[];
  profile?: string;
  databricksHost?: string;
  databricksToken?: string;
  experiment?: string;
  judgeModel?: string;
  warehouse?: string;
  concurrency?: string;
  timeout?: string;
  retries?: string;
  minPassRate?: string;
  reporter?: "text" | "json" | "junit";
  output?: string;
}

async function runAgentEval(
  filter: string | undefined,
  opts: EvalOptions,
): Promise<void> {
  const runner = await loadRunner();

  // Databricks credentials shared by auth resolution and the workspace client:
  // an explicit flag/DATABRICKS_* env wins, else the SDK resolves from the CLI
  // profile.
  const credentials = {
    profile: opts.profile ?? process.env.DATABRICKS_CONFIG_PROFILE,
    host: opts.databricksHost ?? process.env.DATABRICKS_HOST,
    token: opts.databricksToken ?? process.env.DATABRICKS_TOKEN,
  };

  // Resolve Databricks host + bearer the AppKit-native way: an explicit
  // host/token wins; otherwise the SDK mints an OAuth token from the CLI
  // profile — so no hand-set PAT is required.
  const auth = await runner.resolveDatabricksAuth(credentials);
  const host = auth?.host;
  const token = auth?.token;

  // Create a native MLflow "Evaluation run" when creds + an experiment are
  // available (traces live in the app; the run + scores are driven from here).
  const experimentId = opts.experiment ?? process.env.MLFLOW_EXPERIMENT_ID;
  const mlflow =
    host && token && experimentId ? { host, token, experimentId } : undefined;

  // LLM-as-judge: reuse the Databricks creds + a judge serving endpoint.
  const judgeModel = opts.judgeModel ?? process.env.APPKIT_JUDGE_MODEL;
  const judge =
    judgeModel && host && token
      ? { host, token, model: judgeModel }
      : undefined;

  // Managed-dataset reads: a workspace client (same profile/host/token) + a SQL
  // warehouse. Only needed by evals that declare `dataset`.
  const warehouseId = opts.warehouse ?? process.env.DATABRICKS_WAREHOUSE_ID;
  const workspaceClient = runner.resolveWorkspaceClient(credentials);

  // Drive up to N evals/rows concurrently (default serial). Ignore junk input.
  const parsedConcurrency = opts.concurrency
    ? Number.parseInt(opts.concurrency, 10)
    : undefined;
  const maxConcurrency =
    parsedConcurrency && parsedConcurrency > 0 ? parsedConcurrency : undefined;

  // Runner-level default per-eval timeout (ms). A per-eval `timeoutMs` wins.
  const parsedTimeout = opts.timeout
    ? Number.parseInt(opts.timeout, 10)
    : undefined;
  const timeoutMs =
    parsedTimeout && parsedTimeout > 0 ? parsedTimeout : undefined;

  // Extra attempts for evals that fail on an infra error (turn/timeout). Junk
  // or negative input falls back to no retries.
  const parsedRetries = opts.retries
    ? Number.parseInt(opts.retries, 10)
    : undefined;
  const retries =
    parsedRetries && parsedRetries > 0 ? parsedRetries : undefined;

  // In a machine reporter (json/junit), stdout is reserved for the report (it
  // may be piped), so human-facing lines go to stderr and the per-eval live
  // streaming is suppressed. Text mode keeps its current stdout behavior.
  const reporter = opts.reporter ?? "text";
  const machine = reporter !== "text";
  const info = (msg: string): void => {
    if (machine) console.error(msg);
    else console.log(msg);
  };

  // Stream progress as evals run, instead of going silent until the end.
  const onEvent = (event: EvalProgress): void => {
    switch (event.type) {
      case "discovered":
        info(
          `Running ${event.total} eval${event.total === 1 ? "" : "s"} against ${opts.url}\n`,
        );
        break;
      case "run-created":
        info(`MLflow evaluation run: ${event.runId}\n`);
        break;
      case "start":
        if (machine) break;
        process.stdout.write(
          `▸ [${event.index + 1}/${event.total}] ${event.id} … `,
        );
        break;
      case "result": {
        if (machine) break;
        process.stdout.write(`${runner.evalGlyph(event.result)}\n`);
        for (const line of runner.formatEvalDetail(event.result)) {
          console.log(line);
        }
        break;
      }
    }
  };

  const summary = await runner.runEvalsInDir({
    rootDir: opts.root,
    baseUrl: opts.url,
    filter,
    tags: opts.tag,
    strict: opts.strict,
    headers: opts.header ? parseHeaders(opts.header) : undefined,
    mlflow,
    judge,
    workspaceClient,
    warehouseId,
    maxConcurrency,
    timeoutMs,
    retries,
    onEvent,
  });

  // The final human summary always shows (stderr for machine reporters so it
  // never pollutes the report on stdout/file).
  info(`\n${runner.formatSummaryLine(summary.results)}`);

  if (summary.mlflow) {
    const { report, finish } = summary.mlflow;
    info(
      `MLflow: ${report.written} assessment(s) written` +
        (report.skipped ? `, ${report.skipped} skipped` : "") +
        (report.failures.length ? `, ${report.failures.length} failed` : ""),
    );
    for (const f of report.failures) {
      console.error(
        `  ✗ trace ${f.traceId}: ${f.status ?? ""} ${f.error ?? ""}`.trim(),
      );
    }
    if (finish.metricsError) {
      console.error(`  ⚠ metrics not logged: ${finish.metricsError}`);
    }
    if (!finish.finished) {
      console.error(
        `  ✗ run left RUNNING — failed to finish: ${finish.finishError ?? "unknown"}`,
      );
    }
  } else {
    info(
      "\nMLflow evaluation run skipped — pass --experiment (or set" +
        " MLFLOW_EXPERIMENT_ID) plus --profile/--databricks-host to create one.",
    );
  }

  // Machine-readable report: build the string with a pure formatter, then emit
  // it to --output <file> or stdout (kept clean of the human noise above).
  if (machine) {
    const report =
      reporter === "json"
        ? runner.formatResultsJson(summary.results)
        : runner.formatResultsJUnit(summary.results);
    if (opts.output) {
      fs.writeFileSync(opts.output, `${report}\n`);
      info(`Wrote ${reporter} report to ${opts.output}`);
    } else {
      process.stdout.write(`${report}\n`);
    }
  }

  const stats = runner.summarize(summary.results);
  const minPassRate = opts.minPassRate
    ? Number.parseFloat(opts.minPassRate)
    : undefined;
  if (minPassRate !== undefined && !Number.isNaN(minPassRate)) {
    // Threshold mode: gate on the aggregate pass rate rather than requiring
    // every eval to pass.
    const ok = stats.passRate >= minPassRate;
    info(
      `Pass rate ${(stats.passRate * 100).toFixed(0)}% (threshold ${(
        minPassRate * 100
      ).toFixed(0)}%) — ${ok ? "OK" : "below threshold"}`,
    );
    if (!ok) process.exitCode = 1;
  } else if (!stats.allPassed) {
    process.exitCode = 1;
  }
}

export const agentEvalCommand = new Command("eval")
  .description(
    "Run agent evals (config/agents/<id>/evals/*.eval.ts) against a running app",
  )
  .argument(
    "[filter]",
    "Only run evals whose <agent>/<id> contains this substring (or an exact agent id)",
  )
  .option("--url <url>", "Base URL of the running app", "http://localhost:3000")
  .option("--strict", "Fail on soft-assertion misses too", false)
  .option(
    "--root <dir>",
    "Project root containing config/agents/ (default: cwd)",
  )
  .option(
    "--header <header...>",
    "Extra request header as 'Key: value' (repeatable)",
  )
  .option(
    "--tag <tag...>",
    "Only run evals tagged with one of these tags (repeatable)",
  )
  .option(
    "--profile <name>",
    "Databricks CLI profile to authenticate with via OAuth (default: DATABRICKS_CONFIG_PROFILE)",
  )
  .option(
    "--databricks-host <host>",
    "Databricks host for writing MLflow assessments (default: DATABRICKS_HOST)",
  )
  .option(
    "--databricks-token <token>",
    "Databricks token for writing MLflow assessments (default: DATABRICKS_TOKEN)",
  )
  .option(
    "--experiment <id>",
    "MLflow experiment id for the evaluation run (default: MLFLOW_EXPERIMENT_ID)",
  )
  .option(
    "--warehouse <id>",
    "SQL warehouse id for reading managed evaluation datasets (default: DATABRICKS_WAREHOUSE_ID)",
  )
  .option(
    "--judge-model <endpoint>",
    "Databricks serving endpoint to use as the LLM judge for t.judge.* (default: APPKIT_JUDGE_MODEL)",
  )
  .option(
    "--concurrency <n>",
    "Max evals/dataset rows to drive concurrently (default: 1, serial)",
  )
  .option(
    "--timeout <ms>",
    "Default per-eval timeout in ms (a per-eval timeoutMs overrides it)",
  )
  .option(
    "--retries <n>",
    "Re-run an eval up to N times when it fails on an infra error (turn/timeout); assertion failures are not retried",
  )
  .option(
    "--min-pass-rate <rate>",
    "Gate on aggregate pass rate (0..1) instead of requiring every eval to pass; exit 1 when below",
  )
  .addOption(
    new Option(
      "--reporter <format>",
      "Report format: text (live console), json (dashboards), or junit (CI test reporters)",
    )
      .choices(["text", "json", "junit"])
      .default("text"),
  )
  .option(
    "--output <file>",
    "Write the json/junit report to this file instead of stdout (ignored for text)",
  )
  .action(runAgentEval);

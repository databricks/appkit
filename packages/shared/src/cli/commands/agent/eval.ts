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
    concurrency?: number;
    mlflow?: {
      host: string;
      token: string;
      experimentId: string;
      sqlWarehouseId?: string;
    };
    judge?: { host: string; token: string; model: string };
    workspaceClient?: unknown;
    warehouseId?: string;
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
  formatEvalHeadline(result: unknown): string;
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

/** Parse a positive-integer CLI option; junk, zero, or negative → undefined. */
function positiveInt(raw: string | undefined): number | undefined {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return n > 0 ? n : undefined;
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
  concurrency?: number;
  warehouseId?: string;
  timeout?: string;
  retries?: string;
  minPassRate?: string;
  reporter?: "text" | "json" | "junit";
  output?: string;
}

/** Resolved Databricks host + bearer (either field may be absent). */
type Auth = { host?: string; token?: string };

/**
 * Native MLflow "Evaluation run" config — only when creds + an experiment are
 * all present (traces live in the app; the run + scores are driven from here).
 */
function resolveMlflow(opts: EvalOptions, auth: Auth) {
  const experimentId = opts.experiment ?? process.env.MLFLOW_EXPERIMENT_ID;
  if (!(auth.host && auth.token && experimentId)) return undefined;
  // UC-backed experiments need a SQL warehouse to write assessments to their
  // V4 traces. Mirror mlflow's env var, and accept the common DATABRICKS one.
  const sqlWarehouseId =
    opts.warehouseId ??
    process.env.MLFLOW_TRACING_SQL_WAREHOUSE_ID ??
    process.env.DATABRICKS_WAREHOUSE_ID;
  return {
    host: auth.host,
    token: auth.token,
    experimentId,
    ...(sqlWarehouseId ? { sqlWarehouseId } : {}),
  };
}

/** LLM-as-judge config — reuses the Databricks creds + a judge serving endpoint. */
function resolveJudge(opts: EvalOptions, auth: Auth) {
  const model = opts.judgeModel ?? process.env.APPKIT_JUDGE_MODEL;
  return model && auth.host && auth.token
    ? { host: auth.host, token: auth.token, model }
    : undefined;
}

/**
 * Progress reporter: stream each eval as it runs instead of going silent. In a
 * machine reporter (json/junit) the live per-eval streaming is suppressed and
 * banners go to stderr (via `info`), keeping stdout clean for the report.
 */
function makeProgressReporter(
  runner: EvalRunner,
  url: string,
  machine: boolean,
  info: (msg: string) => void,
): (event: EvalProgress) => void {
  return (event) => {
    switch (event.type) {
      case "discovered":
        info(
          `Running ${event.total} eval${event.total === 1 ? "" : "s"} against ${url}\n`,
        );
        break;
      case "run-created":
        info(`MLflow evaluation run: ${event.runId}\n`);
        break;
      case "result": {
        if (machine) break;
        // One full line per completion — evals run concurrently, so a split
        // "start … glyph" prefix would interleave into garbage.
        console.log(
          `[${event.index + 1}/${event.total}] ${runner.formatEvalHeadline(event.result)}`,
        );
        for (const line of runner.formatEvalDetail(event.result)) {
          console.log(line);
        }
        break;
      }
    }
  };
}

function formatFailureLine(f: {
  traceId: string;
  status?: number;
  error?: string;
}): string {
  return `  ✗ trace ${f.traceId}: ${f.status ?? ""} ${f.error ?? ""}`.trim();
}

/**
 * Print the MLflow assessment/finish outcome after a run that created one. The
 * summary line goes through `info` (stderr under a machine reporter); per-trace
 * failures and finish errors always go to stderr.
 */
function printMlflowOutcome(
  mlflow: NonNullable<EvalRunSummary["mlflow"]>,
  info: (msg: string) => void,
): void {
  const { report, finish } = mlflow;
  info(
    `MLflow: ${report.written} assessment(s) written` +
      (report.skipped ? `, ${report.skipped} skipped` : "") +
      (report.failures.length ? `, ${report.failures.length} failed` : ""),
  );
  for (const f of report.failures) {
    console.error(formatFailureLine(f));
  }
  if (finish.metricsError) {
    console.error(`  ⚠ metrics not logged: ${finish.metricsError}`);
  }
  if (!finish.finished) {
    console.error(
      `  ✗ run left RUNNING — failed to finish: ${finish.finishError ?? "unknown"}`,
    );
  }
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
  const auth: Auth = (await runner.resolveDatabricksAuth(credentials)) ?? {};

  // Managed-dataset reads: a workspace client (same profile/host/token) + a SQL
  // warehouse. Only needed by evals that declare `dataset`.
  const warehouseId = opts.warehouseId ?? process.env.DATABRICKS_WAREHOUSE_ID;
  const workspaceClient = runner.resolveWorkspaceClient(credentials);

  // Runner-level default per-eval timeout (ms). A per-eval `timeoutMs` wins.
  const timeoutMs = positiveInt(opts.timeout);

  // Extra attempts for evals that fail on an infra error (turn/timeout). Junk
  // or negative input falls back to no retries.
  const retries = positiveInt(opts.retries);

  // In a machine reporter (json/junit), stdout is reserved for the report (it
  // may be piped), so human-facing lines go to stderr and the per-eval live
  // streaming is suppressed. Text mode keeps its current stdout behavior.
  const reporter = opts.reporter ?? "text";
  const machine = reporter !== "text";
  const info = (msg: string): void => {
    if (machine) console.error(msg);
    else console.log(msg);
  };

  let summary: EvalRunSummary;
  try {
    summary = await runner.runEvalsInDir({
      rootDir: opts.root,
      baseUrl: opts.url,
      filter,
      tags: opts.tag,
      strict: opts.strict,
      headers: opts.header ? parseHeaders(opts.header) : undefined,
      concurrency: opts.concurrency,
      mlflow: resolveMlflow(opts, auth),
      judge: resolveJudge(opts, auth),
      workspaceClient,
      warehouseId,
      timeoutMs,
      retries,
      onEvent: makeProgressReporter(runner, opts.url, machine, info),
    });
  } catch (err) {
    // Setup failures (e.g. a bad --experiment for the MLflow run) reject before
    // any eval runs; surface a clean message + non-zero exit rather than an
    // unhandled promise rejection with a raw stack.
    console.error(
      `\nEval run failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  // The final human summary always shows (stderr for machine reporters so it
  // never pollutes the report on stdout/file).
  info(`\n${runner.formatSummaryLine(summary.results)}`);

  if (summary.mlflow) {
    printMlflowOutcome(summary.mlflow, info);
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
    "Run agent evals (server/agents/<id>/evals/*.eval.ts) against a running app",
  )
  .argument(
    "[filter]",
    "Only run evals whose <agent>/<id> contains this substring (or an exact agent id)",
  )
  .option("--url <url>", "Base URL of the running app", "http://localhost:3000")
  .option("--strict", "Fail on soft-assertion misses too", false)
  .option(
    "--concurrency <n>",
    "Max evals to run concurrently (default 4; keep at or below the app's max concurrent streams per user)",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--root <dir>",
    "Project root containing server/agents/ (default: cwd)",
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
    "--warehouse-id <id>",
    "SQL warehouse id for reading managed eval datasets and writing assessments to UC-backed experiments (default: DATABRICKS_WAREHOUSE_ID, or MLFLOW_TRACING_SQL_WAREHOUSE_ID for assessments)",
  )
  .option(
    "--judge-model <endpoint>",
    "Databricks serving endpoint to use as the LLM judge for t.judge.* (default: APPKIT_JUDGE_MODEL)",
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

import { Command } from "commander";

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
  summarize(results: unknown[]): { allPassed: boolean };
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
  profile?: string;
  databricksHost?: string;
  databricksToken?: string;
  experiment?: string;
  judgeModel?: string;
  concurrency?: number;
  warehouseId?: string;
  warehouse?: string;
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

/** Progress reporter: stream each eval as it runs instead of going silent. */
function makeProgressReporter(
  runner: EvalRunner,
  url: string,
): (event: EvalProgress) => void {
  return (event) => {
    switch (event.type) {
      case "discovered":
        console.log(
          `Running ${event.total} eval${event.total === 1 ? "" : "s"} against ${url}\n`,
        );
        break;
      case "run-created":
        console.log(`MLflow evaluation run: ${event.runId}\n`);
        break;
      case "result": {
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

/** Print the MLflow assessment/finish outcome after a run that created one. */
function printMlflowOutcome(
  mlflow: NonNullable<EvalRunSummary["mlflow"]>,
): void {
  const { report, finish } = mlflow;
  console.log(
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

  // Resolve Databricks host + bearer the AppKit-native way: an explicit
  // host/token (or DATABRICKS_* env) wins; otherwise the SDK mints an OAuth
  // token from the CLI profile — so no hand-set PAT is required.
  const auth: Auth =
    (await runner.resolveDatabricksAuth({
      profile: opts.profile ?? process.env.DATABRICKS_CONFIG_PROFILE,
      host: opts.databricksHost ?? process.env.DATABRICKS_HOST,
      token: opts.databricksToken ?? process.env.DATABRICKS_TOKEN,
    })) ?? {};

  // Managed-dataset reads: a workspace client (same profile/host/token) + a SQL
  // warehouse. Only needed by evals that declare `dataset`.
  const warehouseId = opts.warehouse ?? process.env.DATABRICKS_WAREHOUSE_ID;
  const workspaceClient = runner.resolveWorkspaceClient({
    profile: opts.profile ?? process.env.DATABRICKS_CONFIG_PROFILE,
    host: opts.databricksHost ?? process.env.DATABRICKS_HOST,
    token: opts.databricksToken ?? process.env.DATABRICKS_TOKEN,
  });

  let summary: EvalRunSummary;
  try {
    summary = await runner.runEvalsInDir({
      rootDir: opts.root,
      baseUrl: opts.url,
      filter,
      strict: opts.strict,
      headers: opts.header ? parseHeaders(opts.header) : undefined,
      concurrency: opts.concurrency,
      mlflow: resolveMlflow(opts, auth),
      judge: resolveJudge(opts, auth),
      workspaceClient,
      warehouseId,
      onEvent: makeProgressReporter(runner, opts.url),
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
  console.log(`\n${runner.formatSummaryLine(summary.results)}`);

  if (summary.mlflow) {
    printMlflowOutcome(summary.mlflow);
  } else {
    console.log(
      "\nMLflow evaluation run skipped — pass --experiment (or set" +
        " MLFLOW_EXPERIMENT_ID) plus --profile/--databricks-host to create one.",
    );
  }

  if (!runner.summarize(summary.results).allPassed) {
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
    "SQL warehouse id for writing assessments to UC-backed experiments (default: MLFLOW_TRACING_SQL_WAREHOUSE_ID or DATABRICKS_WAREHOUSE_ID)",
  )
  .option(
    "--warehouse <id>",
    "SQL warehouse id for reading managed evaluation datasets (default: DATABRICKS_WAREHOUSE_ID)",
  )
  .option(
    "--judge-model <endpoint>",
    "Databricks serving endpoint to use as the LLM judge for t.judge.* (default: APPKIT_JUDGE_MODEL)",
  )
  .action(runAgentEval);

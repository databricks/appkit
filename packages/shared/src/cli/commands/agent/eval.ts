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
    mlflow?: { host: string; token: string; experimentId: string };
    judge?: { host: string; token: string; model: string };
    onEvent?: (event: EvalProgress) => void;
  }): Promise<EvalRunSummary>;
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
  databricksHost?: string;
  databricksToken?: string;
  experiment?: string;
  judgeModel?: string;
}

async function runAgentEval(
  filter: string | undefined,
  opts: EvalOptions,
): Promise<void> {
  const runner = await loadRunner();

  // Create a native MLflow "Evaluation run" when Databricks creds + an
  // experiment are available (traces live in the app; the run + scores are
  // driven from here, so this side needs creds).
  const host = opts.databricksHost ?? process.env.DATABRICKS_HOST;
  const token = opts.databricksToken ?? process.env.DATABRICKS_TOKEN;
  const experimentId = opts.experiment ?? process.env.MLFLOW_EXPERIMENT_ID;
  const mlflow =
    host && token && experimentId ? { host, token, experimentId } : undefined;

  // LLM-as-judge: reuse the Databricks creds + a judge serving endpoint.
  const judgeModel = opts.judgeModel ?? process.env.APPKIT_JUDGE_MODEL;
  const judge =
    judgeModel && host && token
      ? { host, token, model: judgeModel }
      : undefined;

  // Stream progress as evals run, instead of going silent until the end.
  const onEvent = (event: EvalProgress): void => {
    switch (event.type) {
      case "discovered":
        console.log(
          `Running ${event.total} eval${event.total === 1 ? "" : "s"} against ${opts.url}\n`,
        );
        break;
      case "run-created":
        console.log(`MLflow evaluation run: ${event.runId}\n`);
        break;
      case "start":
        process.stdout.write(
          `▸ [${event.index + 1}/${event.total}] ${event.id} … `,
        );
        break;
      case "result": {
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
    strict: opts.strict,
    headers: opts.header ? parseHeaders(opts.header) : undefined,
    mlflow,
    judge,
    onEvent,
  });
  console.log(`\n${runner.formatSummaryLine(summary.results)}`);

  if (summary.mlflow) {
    const { report, finish } = summary.mlflow;
    console.log(
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
    console.log(
      "\nMLflow evaluation run skipped — set DATABRICKS_HOST + DATABRICKS_TOKEN" +
        " + MLFLOW_EXPERIMENT_ID (or the matching flags) to create one.",
    );
  }

  if (!runner.summarize(summary.results).allPassed) {
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
    "--judge-model <endpoint>",
    "Databricks serving endpoint to use as the LLM judge for t.judge.* (default: APPKIT_JUDGE_MODEL)",
  )
  .action(runAgentEval);

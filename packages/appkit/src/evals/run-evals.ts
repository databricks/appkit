import { pathToFileURL } from "node:url";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { MlflowClient } from "../connectors/mlflow";
import { type DatasetRow, readEvalDataset } from "./dataset";
import { discoverEvalFiles } from "./discover";
import { createHttpDriver } from "./http-driver";
import { configureJudge } from "./judge";
import { type ReportOutcome, reportToMlflow } from "./mlflow-report";
import { createEvalRun, type FinishOutcome, finishEvalRun } from "./mlflow-run";
import { runEval } from "./run-eval";
import type { EvalDefinition, EvalResult } from "./types";

export interface RunEvalsOptions {
  /** Project root containing `config/agents/`. Defaults to `process.cwd()`. */
  rootDir?: string;
  /** Base URL of the running app to drive, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Substring filter on `<agent>/<id>` (or an exact agent id). */
  filter?: string;
  /** Soft assertion failures also fail the eval. */
  strict?: boolean;
  /** Extra request headers for the driver (e.g. auth for a deployed app). */
  headers?: Record<string, string>;
  /**
   * When set, create a native MLflow "Evaluation run": each eval's trace is
   * linked to the run, pass/fail is written as feedback, and aggregate metrics
   * are logged. Requires Databricks creds + the target experiment.
   */
  mlflow?: { host: string; token: string; experimentId: string };
  /**
   * When set, enable `t.judge.*` LLM-as-judge scoring via autoevals against a
   * Databricks serving endpoint (`model`).
   */
  judge?: { host: string; token: string; model: string };
  /**
   * Workspace client used to read managed evaluation datasets (for evals that
   * declare `dataset`). Required alongside {@link warehouseId} for those evals.
   */
  workspaceClient?: WorkspaceClient;
  /** SQL warehouse id used to read managed evaluation datasets. */
  warehouseId?: string;
  /** Wall-clock timestamp (ms) for run create/finish — pass `Date.now()`. */
  now?: number;
  /** Progress callback, invoked as evals are discovered, started, and finished. */
  onEvent?: (event: EvalProgress) => void;
}

export type EvalProgress =
  | { type: "discovered"; total: number }
  | { type: "run-created"; runId: string }
  | { type: "start"; id: string; index: number; total: number }
  | { type: "result"; result: EvalResult; index: number; total: number };

export interface EvalRunSummary {
  results: EvalResult[];
  /** Present when an MLflow evaluation run was created. */
  mlflow?: { runId: string; report: ReportOutcome; finish: FinishOutcome };
}

/**
 * Load a `*.eval.ts` file and return its default-exported {@link EvalDefinition}.
 * Uses tsx's programmatic loader so TypeScript eval files run without a build
 * step. The specifier is indirected so the type checker doesn't try to resolve
 * tsx's internal entry.
 */
async function loadEval(file: string): Promise<EvalDefinition> {
  const tsxApi = "tsx/esm/api";
  let tsImport: (specifier: string, parentURL: string) => Promise<unknown>;
  try {
    ({ tsImport } = (await import(tsxApi)) as {
      tsImport: (specifier: string, parentURL: string) => Promise<unknown>;
    });
  } catch {
    throw new Error(
      "Running .eval.ts files requires `tsx`. Install it as a dev dependency (`pnpm add -D tsx`).",
    );
  }

  const mod = await tsImport(pathToFileURL(file).href, import.meta.url);
  const def = resolveEvalDefault(mod);
  if (!def) {
    throw new Error(`${file}: must default-export defineEval({ test })`);
  }
  return def;
}

/**
 * Unwrap the eval default export across module-interop shapes. Depending on
 * whether the eval file is treated as ESM or CJS, the value lands at
 * `mod.default` (ESM), `mod.default.default` (CJS `__esModule` double-wrap), or
 * `mod` itself. Returns the first candidate that looks like an eval.
 */
export function resolveEvalDefault(mod: unknown): EvalDefinition | undefined {
  const seen = new Set<unknown>();
  let candidate: unknown = mod;
  for (let i = 0; i < 4 && candidate && !seen.has(candidate); i++) {
    if (typeof (candidate as EvalDefinition).test === "function") {
      return candidate as EvalDefinition;
    }
    seen.add(candidate);
    candidate = (candidate as { default?: unknown }).default;
  }
  return undefined;
}

/**
 * Discover, load, and run every eval under each agent's `evals/` dir, driving
 * the agents on a running app. Never throws for an individual eval — load/run
 * failures become non-passing {@link EvalResult}s.
 */
export async function runEvalsInDir(
  options: RunEvalsOptions,
): Promise<EvalRunSummary> {
  const root = options.rootDir ?? process.cwd();
  const now = options.now ?? Date.now();
  let discovered = discoverEvalFiles(root);

  if (options.filter) {
    const f = options.filter;
    discovered = discovered.filter(
      (d) => d.agent === f || `${d.agent}/${d.id}`.includes(f),
    );
  }

  const emit = options.onEvent ?? (() => {});
  const total = discovered.length;
  emit({ type: "discovered", total });

  if (options.judge) {
    await configureJudge({
      client: new MlflowClient(options.judge.host, options.judge.token),
      token: options.judge.token,
      model: options.judge.model,
    });
  }

  // Create the MLflow evaluation run up front so each eval's trace can be
  // linked to it as it runs. One client is shared by run create/finish and the
  // per-trace assessment writes.
  let runId: string | undefined;
  let mlflowClient: MlflowClient | undefined;
  if (options.mlflow) {
    mlflowClient = new MlflowClient(options.mlflow.host, options.mlflow.token);
    runId = await createEvalRun(mlflowClient, {
      experimentId: options.mlflow.experimentId,
      runName: `appkit-eval ${new Date(now).toISOString()}`,
      startTime: now,
    });
    emit({ type: "run-created", runId });
  }

  const results: EvalResult[] = [];
  // `total` counts eval files, not dataset rows: row counts aren't known until
  // each file loads. Per-row detail is carried in the result id (`[row i/n]`).
  for (let index = 0; index < discovered.length; index++) {
    const d = discovered[index];
    const id = `${d.agent}/${d.id}`;

    let def: EvalDefinition | undefined;
    try {
      def = await loadEval(d.file);
    } catch (err) {
      emit({ type: "start", id, index, total });
      const result: EvalResult = {
        id,
        assertions: [],
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      };
      results.push(result);
      emit({ type: "result", result, index, total });
      continue;
    }

    // Resolve dataset rows up front; a dataset eval with no rows still runs
    // once with an empty row so a misconfiguration surfaces as a result.
    let rows: Array<DatasetRow | undefined> = [undefined];
    let datasetError: string | undefined;
    if (def.dataset) {
      if (!options.workspaceClient || !options.warehouseId) {
        datasetError =
          "dataset eval requires a workspace client and warehouse (pass --warehouse)";
      } else {
        try {
          rows = await readEvalDataset(options.workspaceClient, {
            table: def.dataset.table,
            warehouseId: options.warehouseId,
            limit: def.dataset.limit,
          });
          if (rows.length === 0) rows = [undefined];
        } catch (err) {
          datasetError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    for (let r = 0; r < rows.length; r++) {
      const rowId =
        def.dataset && rows.length > 1
          ? `${id} [row ${r + 1}/${rows.length}]`
          : id;
      emit({ type: "start", id: rowId, index, total });

      let result: EvalResult;
      if (datasetError) {
        result = {
          id: rowId,
          assertions: [],
          passed: false,
          error: datasetError,
        };
      } else {
        // A fresh driver per row: each row is an independent conversation, so
        // its thread must not carry over the previous row's history. (Multiple
        // `t.send`s within one row still share the thread — that's the driver's
        // per-instance behavior.)
        const driver = createHttpDriver({
          baseUrl: options.baseUrl,
          agent: def.agent ?? d.agent,
          headers: options.headers,
          mlflowRunId: runId,
        });
        result = await runEval(def, {
          id: rowId,
          driver,
          strict: options.strict,
          row: rows[r],
        });
      }

      results.push(result);
      emit({ type: "result", result, index, total });
    }
  }

  if (mlflowClient && runId) {
    const report = await reportToMlflow(mlflowClient, results);
    const finish = await finishEvalRun(mlflowClient, {
      runId,
      results,
      endTime: options.now ?? Date.now(),
    });
    return { results, mlflow: { runId, report, finish } };
  }

  return { results };
}

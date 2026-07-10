import { pathToFileURL } from "node:url";
import { MlflowClient } from "../connectors/mlflow";
import type { WorkspaceClient } from "../workspace-client";
import { type DatasetRow, readEvalDataset } from "./dataset";
import { type DiscoveredEval, discoverEvalFiles } from "./discover";
import { createHttpDriver } from "./http-driver";
import { configureJudge, teardownJudge } from "./judge";
import { type ReportOutcome, reportToMlflow } from "./mlflow-report";
import { createEvalRun, type FinishOutcome, finishEvalRun } from "./mlflow-run";
import { mapPool } from "./pool";
import { runEval } from "./run-eval";
import type { EvalDefinition, EvalResult } from "./types";

export interface RunEvalsOptions {
  /** Project root containing `server/agents/`. Defaults to `process.cwd()`. */
  rootDir?: string;
  /** Base URL of the running app to drive, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Substring filter on `<agent>/<id>` (or an exact agent id). */
  filter?: string;
  /** Soft assertion failures also fail the eval. */
  strict?: boolean;
  /** Extra request headers for the driver (e.g. auth for a deployed app). */
  headers?: Record<string, string>;
  /** Per-turn wall-clock timeout (ms) before a turn is failed. Defaults to 120s. */
  timeoutMs?: number;
  /**
   * Max evals to drive concurrently. Each eval opens one stream to the app as
   * the same user, so keep this at or below the app's
   * `maxConcurrentStreamsPerUser` (default 5) or the surplus streams hit the
   * 429 guard. Defaults to 4; clamped to `[1, total]`.
   */
  concurrency?: number;
  /**
   * When set, create a native MLflow "Evaluation run": each eval's trace is
   * linked to the run, pass/fail is written as feedback, and aggregate metrics
   * are logged. Requires Databricks creds + the target experiment.
   */
  mlflow?: {
    host: string;
    token: string;
    experimentId: string;
    /** SQL warehouse id for writing assessments to UC-backed (V4) traces. */
    sqlWarehouseId?: string;
  };
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
  let candidate: unknown = mod;
  for (let i = 0; i < 4 && candidate; i++) {
    if (typeof (candidate as EvalDefinition).test === "function") {
      return candidate as EvalDefinition;
    }
    candidate = (candidate as { default?: unknown }).default;
  }
  return undefined;
}

/**
 * Run one eval turn against a fresh driver. Never throws — a run failure becomes
 * a non-passing {@link EvalResult} so one bad eval can't abort the run. `row`
 * binds the current managed-dataset row (see {@link resolveDatasetRows}), or is
 * `undefined` for a plain single-run eval.
 */
async function runOne(
  d: DiscoveredEval,
  id: string,
  def: EvalDefinition,
  row: DatasetRow | undefined,
  runId: string | undefined,
  options: RunEvalsOptions,
): Promise<EvalResult> {
  try {
    // A fresh driver per row: each row is an independent conversation whose
    // thread must not carry over the previous row's history. (Multiple
    // `t.send`s within one row still share the thread — the driver's behavior.)
    const driver = createHttpDriver({
      baseUrl: options.baseUrl,
      agent: def.agent ?? d.agent,
      headers: options.headers,
      mlflowRunId: runId,
      timeoutMs: options.timeoutMs,
    });
    return await runEval(def, { id, driver, strict: options.strict, row });
  } catch (err) {
    return {
      id,
      assertions: [],
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve the rows a (possibly dataset-driven) eval runs over. A plain eval
 * yields a single `undefined` row; a dataset eval reads its Unity Catalog table
 * via {@link readEvalDataset}. On misconfiguration or read failure, returns a
 * single `undefined` row plus an `error`, so the eval still surfaces one result.
 */
async function resolveDatasetRows(
  def: EvalDefinition,
  options: RunEvalsOptions,
): Promise<{ rows: Array<DatasetRow | undefined>; error?: string }> {
  if (!def.dataset) return { rows: [undefined] };
  if (!options.workspaceClient || !options.warehouseId) {
    return {
      rows: [undefined],
      error:
        "dataset eval requires a workspace client and warehouse (pass --warehouse)",
    };
  }
  try {
    const rows = await readEvalDataset(options.workspaceClient, {
      table: def.dataset.table,
      warehouseId: options.warehouseId,
      limit: def.dataset.limit,
    });
    return { rows: rows.length ? rows : [undefined] };
  } catch (err) {
    return {
      rows: [undefined],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Load one discovered eval and run it, expanding a dataset-driven eval into one
 * run per row. Appends one result per row to `results`, emitting `start`/
 * `result` around each. Never throws: a load or dataset-read failure surfaces as
 * a non-passing result. `total` counts eval files, not rows — per-row detail is
 * carried in the result id (`[row i/n]`).
 */
async function runDiscovered(
  d: DiscoveredEval,
  index: number,
  total: number,
  runId: string | undefined,
  options: RunEvalsOptions,
  emit: (event: EvalProgress) => void,
  results: EvalResult[],
): Promise<void> {
  const id = `${d.agent}/${d.id}`;

  let def: EvalDefinition;
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
    return;
  }

  const { rows, error: datasetError } = await resolveDatasetRows(def, options);

  for (let r = 0; r < rows.length; r++) {
    const rowId =
      def.dataset && rows.length > 1
        ? `${id} [row ${r + 1}/${rows.length}]`
        : id;
    emit({ type: "start", id: rowId, index, total });
    const result: EvalResult = datasetError
      ? { id: rowId, assertions: [], passed: false, error: datasetError }
      : await runOne(d, rowId, def, rows[r], runId, options);
    results.push(result);
    emit({ type: "result", result, index, total });
  }
}

/** Configure the LLM judge when judge creds were supplied; otherwise a no-op. */
async function maybeConfigureJudge(options: RunEvalsOptions): Promise<void> {
  if (!options.judge) return;
  await configureJudge({
    client: new MlflowClient(options.judge.host, options.judge.token),
    token: options.judge.token,
    model: options.judge.model,
  });
}

/**
 * Report per-eval assessments and finish the MLflow run, when one was created.
 * Returns the run summary, or `undefined` when there was no run to finalize.
 */
async function finalizeMlflow(
  client: MlflowClient | undefined,
  runId: string | undefined,
  results: EvalResult[],
  options: RunEvalsOptions,
): Promise<EvalRunSummary["mlflow"]> {
  if (!client || !runId) return undefined;
  // reportToMlflow is not supposed to throw, but if it ever does the run must
  // still be finished — otherwise it hangs in RUNNING forever.
  let report: ReportOutcome = { written: 0, skipped: 0, failures: [] };
  try {
    report = await reportToMlflow(
      client,
      results,
      options.mlflow?.sqlWarehouseId,
    );
  } catch (err) {
    report.failures.push({
      traceId: "(report)",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const finish = await finishEvalRun(client, {
    runId,
    results,
    endTime: options.now ?? Date.now(),
  });
  return { runId, report, finish };
}

/**
 * Default max evals in flight. Each eval opens one stream to the app as the
 * same user; the server caps concurrent streams per user at 5 by default
 * (`maxConcurrentStreamsPerUser`), so 4 leaves headroom under that limit.
 */
const DEFAULT_CONCURRENCY = 4;

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

  // The judge sets OPENAI_* env vars globally (autoevals reads them per call),
  // so tear them down in `finally` once the run is over — pass or throw — so
  // the bearer doesn't linger in process.env.
  await maybeConfigureJudge(options);
  try {
    // Create the MLflow evaluation run up front so each eval's trace can be
    // linked to it as it runs. One client is shared by run create/finish and
    // the per-trace assessment writes.
    let runId: string | undefined;
    let mlflowClient: MlflowClient | undefined;
    if (options.mlflow) {
      mlflowClient = new MlflowClient(
        options.mlflow.host,
        options.mlflow.token,
      );
      runId = await createEvalRun(mlflowClient, {
        experimentId: options.mlflow.experimentId,
        runName: `appkit-eval ${new Date(now).toISOString()}`,
        startTime: now,
      });
      emit({ type: "run-created", runId });
    }

    // Run each eval through the bounded pool — one in-flight stream per eval, so
    // the pool respects the server's per-user stream cap (see mapPool/concurrency).
    // A dataset eval expands into per-row runs that execute serially within its
    // slot; results preserve discovery order (mapPool writes by index) and row
    // order within each file. `total` counts eval files, not dataset rows — per-row
    // detail is carried in the result id (`[row i/n]`).
    const perFile = await mapPool(
      discovered,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      async (d, index) => {
        const fileResults: EvalResult[] = [];
        await runDiscovered(d, index, total, runId, options, emit, fileResults);
        return fileResults;
      },
    );
    const results = perFile.flat();

    const summary: EvalRunSummary = { results };
    const mlflow = await finalizeMlflow(mlflowClient, runId, results, options);
    if (mlflow) summary.mlflow = mlflow;
    return summary;
  } finally {
    teardownJudge();
  }
}

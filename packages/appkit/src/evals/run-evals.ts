import { pathToFileURL } from "node:url";

import { MlflowClient } from "../connectors/mlflow";
import type { WorkspaceClient } from "../workspace-client";
import { type DatasetRow, readEvalDataset } from "./dataset";
import {
  type DiscoveredEval,
  discoverEvalConfigs,
  discoverEvalFiles,
} from "./discover";
import { createHttpDriver } from "./http-driver";
import { configureJudge, teardownJudge } from "./judge";
import { type ReportOutcome, reportToMlflow } from "./mlflow-report";
import { createEvalRun, type FinishOutcome, finishEvalRun } from "./mlflow-run";
import { mapPool } from "./pool";
import { runEval } from "./run-eval";
import type { EvalConfig, EvalDefinition, EvalResult } from "./types";

export interface RunEvalsOptions {
  /** Project root containing `server/agents/`. Defaults to `process.cwd()`. */
  rootDir?: string;
  /** Base URL of the running app to drive, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Substring filter on `<agent>/<id>` (or an exact agent id). */
  filter?: string;
  /**
   * Only run evals whose `tags` intersect this list. Empty/undefined runs all.
   * Tags live on the eval def, so filtering happens after each file is loaded.
   */
  tags?: string[];
  /** Soft assertion failures also fail the eval. */
  strict?: boolean;
  /** Extra request headers for the driver (e.g. auth for a deployed app). */
  headers?: Record<string, string>;
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
  /**
   * Default per-eval timeout (ms): `runEval` races the whole test against it and
   * it also caps each driver turn. A per-eval `def.timeoutMs` overrides it, and
   * it wins over an agent's `evals.config.ts` `timeoutMs`. Unbounded when unset.
   */
  timeoutMs?: number;
  /**
   * Re-run an eval up to this many extra times when it fails on an
   * infrastructure error (a thrown error or timeout — `result.error` set), to
   * absorb transient turn/stream flakiness. Assertion failures are NEVER
   * retried (a wrong reply is real signal, not flake). Defaults to `0`.
   */
  retries?: number;
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
 * Import a TypeScript file with tsx's programmatic loader so eval files run
 * without a build step. The specifier is indirected so the type checker doesn't
 * try to resolve tsx's internal entry.
 */
async function tsImportFile(file: string): Promise<unknown> {
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
  return tsImport(pathToFileURL(file).href, import.meta.url);
}

/**
 * Load a `*.eval.ts` file and return its default-exported {@link EvalDefinition}.
 */
async function loadEval(file: string): Promise<EvalDefinition> {
  const mod = await tsImportFile(file);
  const def = resolveEvalDefault(mod);
  if (!def) {
    throw new Error(`${file}: must default-export defineEval({ test })`);
  }
  return def;
}

/**
 * Load an `evals.config.ts` file and return its default-exported
 * {@link EvalConfig}. A malformed/missing default surfaces as `undefined` so a
 * bad config never aborts a whole run.
 */
async function loadEvalConfig(file: string): Promise<EvalConfig | undefined> {
  const mod = await tsImportFile(file);
  return resolveConfigDefault(mod);
}

/**
 * Unwrap the config default export across module-interop shapes (see
 * {@link resolveEvalDefault}). A config has no `.test`, so the first plain
 * object reached through the `default` chain is taken as the config.
 */
export function resolveConfigDefault(mod: unknown): EvalConfig | undefined {
  const seen = new Set<unknown>();
  let candidate: unknown = mod;
  for (let i = 0; i < 4 && candidate && !seen.has(candidate); i++) {
    const next = (candidate as { default?: unknown }).default;
    if (next === undefined) {
      return typeof candidate === "object"
        ? (candidate as EvalConfig)
        : undefined;
    }
    seen.add(candidate);
    candidate = next;
  }
  return undefined;
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
    // Retry only on an infrastructure error (`result.error` — a thrown error or
    // timeout), to absorb transient turn/stream flakiness; assertion failures
    // are real signal and returned on the first try. Each attempt gets a fresh
    // driver, so its thread never carries over the failed attempt's history.
    return await runWithRetries(options.retries ?? 0, () =>
      runEval(def, {
        id,
        driver: createHttpDriver({
          baseUrl: options.baseUrl,
          agent: def.agent ?? d.agent,
          headers: options.headers,
          mlflowRunId: runId,
          timeoutMs: options.timeoutMs,
        }),
        strict: options.strict,
        row,
        timeoutMs: options.timeoutMs,
      }),
    );
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

/**
 * Run `attempt` up to `1 + retries` times, stopping as soon as it returns a
 * result without an `error` (infra failures — thrown errors or timeouts — set
 * `error`; assertion failures do not, so a failed-but-completed eval is returned
 * on the first try and never retried). Returns the last result when every
 * attempt errored. `retries` below 0 is treated as 0.
 */
export async function runWithRetries(
  retries: number,
  attempt: (attemptNumber: number) => Promise<EvalResult>,
): Promise<EvalResult> {
  const maxAttempts = 1 + Math.max(0, retries);
  let result: EvalResult;
  for (let n = 1; ; n++) {
    result = await attempt(n);
    if (!result.error || n >= maxAttempts) return result;
  }
}

/**
 * Whether an eval's `tags` satisfy a `--tag` filter: `true` when the filter is
 * empty/undefined (no filtering), otherwise only when the eval shares at least
 * one tag with it. An eval with no tags never matches a non-empty filter.
 */
export function matchesTags(
  defTags: string[] | undefined,
  filterTags: string[] | undefined,
): boolean {
  if (!filterTags || filterTags.length === 0) return true;
  return defTags?.some((t) => filterTags.includes(t)) ?? false;
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

  // Load each agent's `evals.config.ts` (best-effort, per-agent): its settings
  // apply only to that agent's evals. A malformed/missing config never aborts
  // the run — the agent just falls back to CLI options and built-in defaults.
  const configs = new Map<string, EvalConfig>();
  for (const c of discoverEvalConfigs(root)) {
    try {
      const cfg = await loadEvalConfig(c.file);
      if (cfg) configs.set(c.agent, cfg);
    } catch {
      // Ignore: fall back to CLI options / defaults for this agent.
    }
  }

  // Load each eval def and apply the `--tag` filter up front. Tags live on the
  // def, so a tag miss removes the eval entirely (like the substring filter
  // excludes files) rather than surfacing as a result. Load failures are kept
  // so a broken file still reports as a non-passing result.
  const loaded: Array<{
    d: DiscoveredEval;
    def: EvalDefinition;
    loadError?: string;
  }> = [];
  for (const d of discovered) {
    let def: EvalDefinition;
    try {
      def = await loadEval(d.file);
    } catch (err) {
      loaded.push({
        d,
        // No def loaded; placeholder def is never run (error short-circuits).
        def: { test: () => {} },
        loadError: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!matchesTags(def.tags, options.tags)) continue;
    loaded.push({ d, def });
  }

  // `evals.config.ts` `maxConcurrency` governs the single shared work pool, so
  // it can't be applied per-agent without splitting the pool. The `--concurrency`
  // flag wins; else the highest value any agent's config requests (the pool
  // ceiling); else the built-in default.
  const configMaxConcurrency = [...configs.values()]
    .map((c) => c.maxConcurrency)
    .filter((n): n is number => typeof n === "number")
    .reduce<number | undefined>(
      (max, n) => (max === undefined ? n : Math.max(max, n)),
      undefined,
    );
  const concurrency =
    options.concurrency ?? configMaxConcurrency ?? DEFAULT_CONCURRENCY;

  const total = loaded.length;
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

    // Run each loaded (tag-filtered) eval through the bounded pool — one in-flight
    // stream per eval, so the pool respects the server's per-user stream cap (see
    // mapPool/concurrency). A dataset eval expands into per-row runs that execute
    // serially within its slot; results preserve discovery order (mapPool writes
    // by index) and row order within each file. Per-agent timeout is folded into
    // the file's options (CLI wins over `evals.config.ts`; `def.timeoutMs` still
    // overrides, applied inside runEval). `total` counts eval files, not dataset
    // rows — per-row detail is carried in the result id (`[row i/n]`).
    const perFile = await mapPool(loaded, concurrency, async ({ d }, index) => {
      const fileResults: EvalResult[] = [];
      const fileOptions: RunEvalsOptions = {
        ...options,
        timeoutMs: options.timeoutMs ?? configs.get(d.agent)?.timeoutMs,
      };
      await runDiscovered(
        d,
        index,
        total,
        runId,
        fileOptions,
        emit,
        fileResults,
      );
      return fileResults;
    });
    const results = perFile.flat();

    const summary: EvalRunSummary = { results };
    const mlflow = await finalizeMlflow(mlflowClient, runId, results, options);
    if (mlflow) summary.mlflow = mlflow;
    return summary;
  } finally {
    teardownJudge();
  }
}

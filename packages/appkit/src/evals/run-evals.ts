import { pathToFileURL } from "node:url";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { MlflowClient } from "../connectors/mlflow";
import { type DatasetRow, readEvalDataset } from "./dataset";
import {
  type DiscoveredEval,
  discoverEvalConfigs,
  discoverEvalFiles,
} from "./discover";
import { createHttpDriver } from "./http-driver";
import { configureJudge } from "./judge";
import { type ReportOutcome, reportToMlflow } from "./mlflow-report";
import { createEvalRun, type FinishOutcome, finishEvalRun } from "./mlflow-run";
import { runEval } from "./run-eval";
import type { EvalConfig, EvalDefinition, EvalResult } from "./types";

export interface RunEvalsOptions {
  /** Project root containing `config/agents/`. Defaults to `process.cwd()`. */
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
  /**
   * Max evals/dataset rows to drive concurrently. Defaults to `1` (serial).
   * Values below 1 are clamped to 1. Output order is preserved regardless.
   * Wins over an agent's `evals.config.ts` `maxConcurrency`.
   */
  maxConcurrency?: number;
  /**
   * Default per-eval timeout (ms). A per-eval `def.timeoutMs` overrides it.
   * Wins over an agent's `evals.config.ts` `timeoutMs`.
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
 * Run `tasks` through a bounded worker pool and return their results in the
 * SAME order as the input, regardless of completion order. Each task receives
 * its input index so callers can key on it. `limit` is clamped to at least 1
 * (and to the task count); at `limit === 1` this is a serial loop. Individual
 * task rejections are surfaced per-slot via `settle` rather than aborting
 * siblings — but eval tasks never reject (failures become results).
 */
export async function runBounded<T, R>(
  tasks: ReadonlyArray<T>,
  limit: number,
  worker: (task: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(tasks.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, tasks.length));
  let next = 0;
  async function pump(): Promise<void> {
    // Each worker pulls the next unclaimed index until the queue drains, so a
    // fast task immediately picks up more work instead of waiting on siblings.
    while (next < tasks.length) {
      const index = next++;
      results[index] = await worker(tasks[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => pump()));
  return results;
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

/** One unit of work: a single {@link runEval} call bound to its output slot. */
interface WorkItem {
  /** File index (used for progress `index`, matches serial behavior). */
  index: number;
  /** Display id, including the `[row i/n]` suffix for dataset rows. */
  rowId: string;
  def: EvalDefinition;
  /** Parent dir agent, used when `def.agent` is unset. */
  dirAgent: string;
  row: DatasetRow | undefined;
  /**
   * Runner-level default timeout (ms) for this item, resolved from CLI options
   * then the agent's `evals.config.ts`. `def.timeoutMs` still overrides it.
   */
  timeoutMs?: number;
  /** Set when the file failed to load or the dataset failed to read. */
  error?: string;
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
  // it can't be applied per-agent without splitting the pool. CLI wins; else
  // the highest value any agent's config requests (the pool ceiling); else 1.
  const configMaxConcurrency = [...configs.values()]
    .map((c) => c.maxConcurrency)
    .filter((n): n is number => typeof n === "number")
    .reduce<number | undefined>(
      (max, n) => (max === undefined ? n : Math.max(max, n)),
      undefined,
    );
  const maxConcurrency = options.maxConcurrency ?? configMaxConcurrency ?? 1;

  const total = loaded.length;
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

  // Expand the loaded evals into a flat, ordered work list SERIALLY: reading a
  // dataset is cheap next to the agent turns, and doing it in order preserves
  // both output ordering and error handling (a dataset failure becomes a
  // non-passing result in its own slot). `total` counts eval files, not dataset
  // rows: per-row detail is carried in the result id (`[row i/n]`).
  const items: WorkItem[] = [];
  for (let index = 0; index < loaded.length; index++) {
    const { d, def, loadError } = loaded[index];
    const id = `${d.agent}/${d.id}`;

    // Runner default timeout for this agent: CLI wins over its config value;
    // a per-eval `def.timeoutMs` overrides both (applied inside runEval).
    const timeoutMs = options.timeoutMs ?? configs.get(d.agent)?.timeoutMs;

    if (loadError) {
      items.push({
        index,
        rowId: id,
        def,
        dirAgent: d.agent,
        row: undefined,
        timeoutMs,
        error: loadError,
      });
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
      items.push({
        index,
        rowId,
        def,
        dirAgent: d.agent,
        row: rows[r],
        timeoutMs,
        error: datasetError,
      });
    }
  }

  // Run the per-row `runEval` calls through a bounded pool. `runBounded`
  // places each result in its input slot, so `results` keeps discovery/row
  // order regardless of completion order. Progress events fire live and may
  // interleave when maxConcurrency > 1.
  const results = await runBounded(
    items,
    maxConcurrency,
    async (item): Promise<EvalResult> => {
      emit({ type: "start", id: item.rowId, index: item.index, total });

      let result: EvalResult;
      if (item.error) {
        result = {
          id: item.rowId,
          assertions: [],
          passed: false,
          error: item.error,
        };
      } else {
        // Retry only on an infrastructure error (`result.error` — a thrown
        // error or timeout), to absorb transient turn/stream flakiness;
        // assertion failures are real signal and returned on the first try.
        // Each attempt gets a fresh driver so its thread doesn't carry over the
        // failed attempt's history.
        result = await runWithRetries(options.retries ?? 0, () =>
          runEval(item.def, {
            id: item.rowId,
            driver: createHttpDriver({
              baseUrl: options.baseUrl,
              agent: item.def.agent ?? item.dirAgent,
              headers: options.headers,
              mlflowRunId: runId,
            }),
            strict: options.strict,
            row: item.row,
            timeoutMs: item.timeoutMs,
          }),
        );
      }

      emit({ type: "result", result, index: item.index, total });
      return result;
    },
  );

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

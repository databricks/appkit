import { type MlflowRestOptions, mlflowPost } from "./mlflow-rest";
import type { EvalResult } from "./types";

/** Run tag value that makes a run appear under the experiment's "Evaluation runs". */
const GENAI_EVALUATE_RUN_TYPE = "genai_evaluate";

interface CreateRunResponse {
  run: { info: { run_id?: string; run_uuid?: string } };
}

interface MlflowMetric {
  key: string;
  value: number;
  timestamp: number;
  step: number;
}

/**
 * Create an MLflow run tagged as a GenAI evaluation, so it shows under the
 * experiment's "Evaluation runs". Returns the run id; link traces to it via the
 * `mlflow.sourceRun` trace metadata and log results before finishing.
 */
export async function createEvalRun(
  options: MlflowRestOptions & {
    experimentId: string;
    runName?: string;
    startTime: number;
  },
): Promise<string> {
  const created = await mlflowPost<CreateRunResponse>(
    options,
    "/api/2.0/mlflow/runs/create",
    {
      experiment_id: options.experimentId,
      start_time: options.startTime,
      ...(options.runName ? { run_name: options.runName } : {}),
    },
  );
  const runId = created.run?.info?.run_id ?? created.run?.info?.run_uuid;
  if (!runId) {
    throw new Error("runs/create returned no run id");
  }
  await mlflowPost(options, "/api/2.0/mlflow/runs/set-tag", {
    run_id: runId,
    key: "mlflow.runType",
    value: GENAI_EVALUATE_RUN_TYPE,
  });
  return runId;
}

/** Aggregate per-eval results into MLflow run metrics. */
export function aggregateMetrics(
  results: EvalResult[],
  timestamp: number,
): MlflowMetric[] {
  const scored = results.filter((r) => !r.skipped);
  const passed = scored.filter((r) => r.passed).length;
  return [
    { key: "eval/total", value: results.length, timestamp, step: 0 },
    { key: "eval/scored", value: scored.length, timestamp, step: 0 },
    { key: "eval/passed", value: passed, timestamp, step: 0 },
    {
      key: "eval/pass_rate",
      value: scored.length ? passed / scored.length : 0,
      timestamp,
      step: 0,
    },
  ];
}

export interface FinishOutcome {
  finished: boolean;
  /** Metric logging is best-effort; set when it failed (the run is still finished). */
  metricsError?: string;
  /** Set when the FINISHED update itself failed (run may be left RUNNING). */
  finishError?: string;
}

/**
 * Log aggregate metrics (best-effort) and mark the eval run FINISHED. Never
 * throws — a metric-logging failure must not prevent the run from being closed,
 * or it would be left stuck in RUNNING forever.
 */
export async function finishEvalRun(
  options: MlflowRestOptions & {
    runId: string;
    results: EvalResult[];
    endTime: number;
  },
): Promise<FinishOutcome> {
  const outcome: FinishOutcome = { finished: false };

  const metrics = aggregateMetrics(options.results, options.endTime);
  if (metrics.length) {
    try {
      await mlflowPost(options, "/api/2.0/mlflow/runs/log-batch", {
        run_id: options.runId,
        metrics,
      });
    } catch (err) {
      outcome.metricsError = err instanceof Error ? err.message : String(err);
    }
  }

  try {
    await mlflowPost(options, "/api/2.0/mlflow/runs/update", {
      run_id: options.runId,
      status: "FINISHED",
      end_time: options.endTime,
    });
    outcome.finished = true;
  } catch (err) {
    outcome.finishError = err instanceof Error ? err.message : String(err);
  }

  return outcome;
}

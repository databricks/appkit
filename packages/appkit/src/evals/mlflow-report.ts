import type { MlflowClient, PostResult } from "../connectors/mlflow";
import { mapPool } from "./pool";
import type { AssertionResult, EvalResult } from "./types";

/**
 * Max assessment writes in flight. Independent per-trace REST POSTs to the
 * Databricks MLflow API; bounded to stay well under its rate limits.
 */
const ASSESSMENT_WRITE_CONCURRENCY = 8;

/**
 * Retry budget for a 404 on an assessment write. The app exports each turn's
 * trace asynchronously, so a write issued right after the run can beat the
 * trace into the store (404 "trace not found"); linear backoff rides out that
 * ingestion lag. Only 404s retry — a 4xx/5xx won't resolve by waiting.
 */
const ASSESSMENT_WRITE_RETRIES = 5;
const ASSESSMENT_RETRY_BASE_MS = 500;
const TRACE_NOT_FOUND = 404;

/** A Feedback assessment in the MLflow REST proto-JSON shape. */
export interface Assessment {
  trace_id: string;
  assessment_name: string;
  source: { source_type: "CODE" | "HUMAN" | "LLM_JUDGE"; source_id: string };
  feedback: { value: unknown };
  rationale?: string;
  metadata?: Record<string, string>;
}

export interface ReportOutcome {
  written: number;
  skipped: number;
  failures: Array<{ traceId: string; status?: number; error?: string }>;
}

/**
 * MLflow assessment names reject `.` (and we avoid spaces/parens too), so map
 * anything outside `[A-Za-z0-9_-]` to `_`. The judge check on the raw label
 * (`judge.`-prefixed) is unaffected — it runs before sanitization.
 */
function sanitizeName(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Build the Feedback assessments for an eval result: one per assertion (judge
 * assertions tagged `LLM_JUDGE` with their numeric score + rationale, so they
 * render as judge feedback in MLflow) plus an overall `appkit_eval` pass/fail.
 * Returns [] when there's no trace to attach to or the eval was skipped.
 */
/** One Feedback assessment for a single assertion (judge assertions tagged `LLM_JUDGE`). */
function assertionAssessment(
  a: AssertionResult,
  traceId: string,
  name: string,
  evalId: string,
): Assessment {
  const isJudge = a.label.startsWith("judge.");
  return {
    trace_id: traceId,
    assessment_name: name,
    source: isJudge
      ? { source_type: "LLM_JUDGE", source_id: "appkit-judge" }
      : { source_type: "CODE", source_id: "appkit-eval" },
    // Judges report a numeric score; deterministic assertions a boolean.
    feedback: { value: a.score ?? a.pass },
    rationale: a.detail,
    metadata: { eval_id: evalId, severity: a.severity },
  };
}

/** The overall `appkit_eval` pass/fail assessment for an eval result. */
function overallAssessment(result: EvalResult, traceId: string): Assessment {
  return {
    trace_id: traceId,
    assessment_name: "appkit_eval",
    source: { source_type: "CODE", source_id: "appkit-eval" },
    feedback: { value: result.passed },
    // Persist only a generic marker, never `result.error` itself: this rationale
    // is POSTed to MLflow and readable by anyone with access to the experiment,
    // a broader audience than the runner. The full error stays on the operator
    // console (printed via the reporter's per-eval detail line).
    rationale: result.error
      ? "eval errored"
      : result.passed
        ? "all gates passed"
        : "one or more gates failed",
    metadata: { eval_id: result.id },
  };
}

export function buildAssessments(result: EvalResult): Assessment[] {
  if (!result.traceId || result.skipped) return [];
  const traceId = result.traceId;
  const out: Assessment[] = [];
  const used = new Map<string, number>();

  for (const a of result.assertions) {
    const base = sanitizeName(a.label);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const name = seen === 0 ? base : `${base}_${seen + 1}`;
    out.push(assertionAssessment(a, traceId, name, result.id));
  }

  out.push(overallAssessment(result, traceId));
  return out;
}

/**
 * A Unity Catalog V4 trace id: `trace:/<catalog.schema[.prefix]>/<otel_hex>`.
 * Databricks addresses these with the location and the bare hex as *separate*
 * path segments (mirrors MLflow's `parse_trace_id_v4`).
 */
const V4_TRACE_ID = /^trace:\/([^/]+)\/([^/]+)$/;

/**
 * Build the REST request to create one assessment, dispatching on the trace-id
 * form:
 * - **V4 UC** (`trace:/<location>/<hex>`) → `POST /api/4.0/mlflow/traces/
 *   {location}/{hex}/assessments`, body is the bare assessment (the Databricks
 *   RPC maps `location_id` from the path). This is the path UC-backed
 *   experiments require — the V3 endpoint 400s on a V4 id.
 * - **V3** (`tr-...`, classic experiments) → `POST /api/3.0/mlflow/traces/
 *   {trace_id}/assessments`, body wraps the assessment in `{ assessment }`.
 */
function assessmentRequest(
  assessment: Assessment,
  sqlWarehouseId?: string,
): {
  path: string;
  body: unknown;
} {
  const v4 = V4_TRACE_ID.exec(assessment.trace_id);
  if (v4) {
    const [, location, id] = v4;
    // UC trace assessments are backed by a SQL warehouse; Databricks requires
    // its id as a query param (mlflow's `_append_sql_warehouse_id_param`).
    const query = sqlWarehouseId
      ? `?sql_warehouse_id=${encodeURIComponent(sqlWarehouseId)}`
      : "";
    return {
      path: `/api/4.0/mlflow/traces/${encodeURIComponent(location)}/${id}/assessments${query}`,
      body: assessment,
    };
  }
  return {
    path: `/api/3.0/mlflow/traces/${encodeURIComponent(assessment.trace_id)}/assessments`,
    body: { assessment },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write one assessment, retrying on a 404 (trace not yet ingested) with linear
 * backoff. Returns the final {@link PostResult}; non-404 failures return on the
 * first attempt.
 */
async function writeAssessment(
  client: MlflowClient,
  assessment: Assessment,
  sqlWarehouseId?: string,
): Promise<PostResult> {
  const { path, body } = assessmentRequest(assessment, sqlWarehouseId);
  let res = await client.postResult(path, body);
  for (
    let attempt = 1;
    attempt <= ASSESSMENT_WRITE_RETRIES &&
    !res.ok &&
    res.status === TRACE_NOT_FOUND;
    attempt++
  ) {
    await sleep(ASSESSMENT_RETRY_BASE_MS * attempt);
    res = await client.postResult(path, body);
  }
  return res;
}

/**
 * Write one pass/fail assessment per eval result to the Databricks MLflow REST
 * API. Never throws — failures are collected so the run still reports.
 */
export async function reportToMlflow(
  client: MlflowClient,
  results: EvalResult[],
  sqlWarehouseId?: string,
): Promise<ReportOutcome> {
  const outcome: ReportOutcome = { written: 0, skipped: 0, failures: [] };

  // Build every assessment first (pure, no I/O). `skipped` counts results with
  // no trace to attach to; `written`/`failures` are counted per assessment.
  const assessments: Assessment[] = [];
  for (const result of results) {
    const built = buildAssessments(result);
    if (built.length === 0) {
      outcome.skipped++;
      continue;
    }
    assessments.push(...built);
  }

  // The writes are independent per-trace REST calls, so run them through a
  // bounded pool instead of strictly serial. postResult never throws.
  const posts = await mapPool(assessments, ASSESSMENT_WRITE_CONCURRENCY, (a) =>
    writeAssessment(client, a, sqlWarehouseId),
  );
  for (let i = 0; i < posts.length; i++) {
    const res = posts[i];
    if (res.ok) {
      outcome.written++;
    } else {
      outcome.failures.push({
        traceId: assessments[i].trace_id,
        status: res.status,
        error: res.error,
      });
    }
  }
  return outcome;
}

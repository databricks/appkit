import { normalizeHost } from "./mlflow-rest";
import type { EvalResult } from "./types";

/** A Feedback assessment in the MLflow REST proto-JSON shape. */
export interface Assessment {
  trace_id: string;
  assessment_name: string;
  source: { source_type: "CODE" | "HUMAN" | "LLM_JUDGE"; source_id: string };
  feedback: { value: unknown };
  rationale?: string;
  metadata?: Record<string, string>;
}

export interface MlflowReportOptions {
  /** Databricks workspace host (scheme optional — normalized). */
  host: string;
  /** Bearer token for the MLflow REST API. */
  token: string;
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
export function buildAssessments(result: EvalResult): Assessment[] {
  if (!result.traceId || result.skipped) return [];
  const traceId = result.traceId;
  const out: Assessment[] = [];
  const used = new Map<string, number>();

  for (const a of result.assertions) {
    const isJudge = a.label.startsWith("judge.");
    const base = sanitizeName(a.label);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    out.push({
      trace_id: traceId,
      assessment_name: seen === 0 ? base : `${base}_${seen + 1}`,
      source: isJudge
        ? { source_type: "LLM_JUDGE", source_id: "appkit-judge" }
        : { source_type: "CODE", source_id: "appkit-eval" },
      // Judges report a numeric score; deterministic assertions a boolean.
      feedback: { value: a.score ?? a.pass },
      rationale: a.detail,
      metadata: { eval_id: result.id, severity: a.severity },
    });
  }

  out.push({
    trace_id: traceId,
    assessment_name: "appkit_eval",
    source: { source_type: "CODE", source_id: "appkit-eval" },
    feedback: { value: result.passed },
    rationale: result.error
      ? `error: ${result.error}`
      : result.passed
        ? "all gates passed"
        : "one or more gates failed",
    metadata: { eval_id: result.id },
  });

  return out;
}

async function postAssessment(
  host: string,
  token: string,
  assessment: Assessment,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = `${normalizeHost(host)}/api/3.0/mlflow/traces/${encodeURIComponent(
    assessment.trace_id,
  )}/assessments`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ assessment }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Write one pass/fail assessment per eval result to the Databricks MLflow REST
 * API. Never throws — failures are collected so the run still reports.
 */
export async function reportToMlflow(
  results: EvalResult[],
  options: MlflowReportOptions,
): Promise<ReportOutcome> {
  const outcome: ReportOutcome = { written: 0, skipped: 0, failures: [] };
  for (const result of results) {
    const assessments = buildAssessments(result);
    if (assessments.length === 0) {
      outcome.skipped++;
      continue;
    }
    for (const assessment of assessments) {
      const res = await postAssessment(options.host, options.token, assessment);
      if (res.ok) {
        outcome.written++;
      } else {
        outcome.failures.push({
          traceId: assessment.trace_id,
          status: res.status,
          error: res.error,
        });
      }
    }
  }
  return outcome;
}

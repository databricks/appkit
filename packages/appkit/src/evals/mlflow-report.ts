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
 * Build the single pass/fail Feedback assessment for an eval result. Returns
 * undefined when there's no trace to attach to or the eval was skipped.
 */
export function buildAssessment(result: EvalResult): Assessment | undefined {
  if (!result.traceId || result.skipped) return undefined;

  const failed = result.assertions.filter((a) => !a.pass);
  const rationale = result.error
    ? `error: ${result.error}`
    : failed.length
      ? failed
          .map(
            (a) =>
              `${a.severity}:${a.label}${a.detail ? ` (${a.detail})` : ""}`,
          )
          .join("; ")
      : "all assertions passed";

  return {
    trace_id: result.traceId,
    assessment_name: "appkit_eval",
    source: { source_type: "CODE", source_id: "appkit-eval" },
    feedback: { value: result.passed },
    rationale,
    metadata: { eval_id: result.id },
  };
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
    const assessment = buildAssessment(result);
    if (!assessment) {
      outcome.skipped++;
      continue;
    }
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
  return outcome;
}

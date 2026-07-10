import type { LiveSpan } from "mlflow-tracing";
import { normalizeHost } from "../../connectors/mlflow";
import { createLogger } from "../../logging/logger";

const logger = createLogger("agents");

type MlflowModule = typeof import("mlflow-tracing");

let mlflow: MlflowModule | undefined;
let enabled = false;
let initStarted = false;

/** The bound MLflow experiment id, from the optional `experiment` resource. */
function experimentId(): string | undefined {
  const id = process.env.MLFLOW_EXPERIMENT_ID?.trim();
  return id || undefined;
}

/**
 * Databricks host with a scheme. The mlflow-tracing SDK uses `DATABRICKS_HOST`
 * verbatim to build request URLs and doesn't add `https://`, so a bare host
 * (`workspace.cloud.databricks.com`) makes `new URL()` throw. Pass an explicit
 * normalized host when the env var is set; when it isn't (profile-based auth),
 * return undefined and let the SDK read the host from `~/.databrickscfg`.
 */
function normalizedDatabricksHost(): string | undefined {
  const raw = process.env.DATABRICKS_HOST?.trim();
  if (!raw) return undefined;
  return normalizeHost(raw);
}

/**
 * Initialize MLflow agent tracing once, when an experiment is bound — i.e. the
 * agents plugin's optional `experiment` resource is set (`MLFLOW_EXPERIMENT_ID`).
 *
 * Auth is resolved by the `mlflow-tracing` SDK from the app's own Databricks
 * credentials — `DATABRICKS_HOST`/`DATABRICKS_TOKEN` or a `~/.databrickscfg`
 * profile (`MLFLOW_TRACKING_URI=databricks://profile`) — so no tokens or OTLP
 * headers are wired by hand. A failure (missing creds, bad experiment) logs and
 * leaves tracing disabled rather than breaking the agent.
 *
 * Safe to call repeatedly; only the first call does work.
 */
export async function initAgentTracing(): Promise<void> {
  if (initStarted) return;
  initStarted = true;

  const id = experimentId();
  if (!id) return;

  try {
    mlflow = await import("mlflow-tracing");
    const host = normalizedDatabricksHost();
    mlflow.init({
      trackingUri: process.env.MLFLOW_TRACKING_URI?.trim() || "databricks",
      experimentId: id,
      ...(host ? { host } : {}),
    });
    enabled = true;
    logger.info("MLflow agent tracing enabled (experiment %s)", id);
  } catch (err) {
    logger.warn("MLflow agent tracing disabled: %O", err);
  }
}

export type AgentSpanType = "AGENT" | "TOOL";

/**
 * Run `fn` inside an MLflow span when tracing is enabled, otherwise just run it
 * (zero overhead). Spans auto-nest via the SDK's active context, so a TOOL span
 * opened inside an AGENT span's callback becomes its child. The callback gets
 * the span (or `undefined` when disabled) to record outputs.
 */
export async function withAgentSpan<T>(
  options: { name: string; type: AgentSpanType; inputs?: unknown },
  fn: (span?: LiveSpan) => Promise<T>,
): Promise<T> {
  if (!enabled || !mlflow) return fn();
  const spanType =
    options.type === "AGENT" ? mlflow.SpanType.AGENT : mlflow.SpanType.TOOL;
  return await mlflow.withSpan<T>(
    (span) => {
      if (options.inputs !== undefined) span.setInputs(options.inputs);
      return fn(span);
    },
    { name: options.name, spanType },
  );
}

/**
 * The MLflow trace id for the active turn, when tracing is enabled. Read inside
 * an agent span so eval runs can correlate the turn to its trace and attach
 * assessments. Returns undefined when tracing is off.
 */
export function currentTraceId(): string | undefined {
  if (!enabled || !mlflow) return undefined;
  try {
    return mlflow.getLastActiveTraceId();
  } catch {
    return undefined;
  }
}

/**
 * Link the active turn's trace to an MLflow run by id, via the `mlflow.sourceRun`
 * trace metadata. Used by eval runs so each case's trace shows under the run.
 * Must be called while a trace is active (inside an agent span). No-op when
 * tracing is disabled.
 */
export function linkTraceToRun(runId: string): void {
  if (!enabled || !mlflow) return;
  try {
    mlflow.updateCurrentTrace({ metadata: { "mlflow.sourceRun": runId } });
  } catch (err) {
    logger.warn("Failed to link trace to run %s: %O", runId, err);
  }
}

/**
 * Populate the trace-level Request/Response columns and the trace name shown in
 * the MLflow traces table (span-level inputs/outputs don't fill these, and the
 * Trace-name column reads the `mlflow.traceName` tag, not the root span name).
 * The Source column is run-derived (via `mlflow.sourceRun`), so a live chat
 * turn with no run leaves it empty — it's only set for eval runs, where the run
 * itself carries the source tags. No-op when tracing is off.
 */
export function updateTracePreview(opts: {
  request?: string;
  response?: string;
  name?: string;
}): void {
  if (!enabled || !mlflow) return;
  try {
    mlflow.updateCurrentTrace({
      ...(opts.request !== undefined ? { requestPreview: opts.request } : {}),
      ...(opts.response !== undefined
        ? { responsePreview: opts.response }
        : {}),
      ...(opts.name ? { tags: { "mlflow.traceName": opts.name } } : {}),
    });
  } catch (err) {
    logger.warn("Failed to update trace preview: %O", err);
  }
}

/** Flush buffered traces (e.g. on shutdown). No-op when tracing is disabled. */
export async function flushAgentTraces(): Promise<void> {
  if (!enabled || !mlflow) return;
  try {
    await mlflow.flushTraces();
  } catch (err) {
    logger.warn("MLflow trace flush failed: %O", err);
  }
}

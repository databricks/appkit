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
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
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

/**
 * Records a span's outputs. Callers get one from `traceAgent`/`traceTool`;
 * it's a no-op when tracing is disabled, so call sites never branch on it.
 */
export interface SpanRecorder {
  setOutputs(outputs: unknown): void;
}

const noopRecorder: SpanRecorder = { setOutputs() {} };

/**
 * Run `fn` inside an MLflow span of `spanType` when tracing is enabled,
 * otherwise just run it (zero overhead). Spans auto-nest via the SDK's active
 * context, so a TOOL span opened inside an AGENT span's callback becomes its
 * child. The callback's resolved value is recorded as the span's outputs unless
 * it called `setOutputs` first; return `undefined` (or set outputs explicitly)
 * when the return value isn't the output you want traced.
 */
async function trace<T>(
  spanType: "AGENT" | "TOOL",
  name: string,
  inputs: unknown,
  fn: (span: SpanRecorder) => Promise<T>,
): Promise<T> {
  if (!enabled || !mlflow) return fn(noopRecorder);
  const type =
    spanType === "AGENT" ? mlflow.SpanType.AGENT : mlflow.SpanType.TOOL;
  return await mlflow.withSpan<T>(
    async (span) => {
      if (inputs !== undefined) span.setInputs(inputs);
      let outputsSet = false;
      const result = await fn({
        setOutputs(outputs) {
          outputsSet = true;
          span.setOutputs(outputs);
        },
      });
      if (!outputsSet && result !== undefined) span.setOutputs(result);
      return result;
    },
    { name, spanType: type },
  );
}

/** Trace a turn's root AGENT span. See {@link trace}. */
export function traceAgent<T>(
  name: string,
  inputs: unknown,
  fn: (span: SpanRecorder) => Promise<T>,
): Promise<T> {
  return trace("AGENT", name, inputs, fn);
}

/** Trace a TOOL span, nested under the active AGENT span. See {@link trace}. */
export function traceTool<T>(
  name: string,
  inputs: unknown,
  fn: (span: SpanRecorder) => Promise<T>,
): Promise<T> {
  return trace("TOOL", name, inputs, fn);
}

/**
 * The MLflow trace id for the active turn, when tracing is enabled. Must be
 * read inside an agent span so eval runs can correlate the turn to its trace
 * and attach assessments. Returns undefined when tracing is off.
 *
 * Reads the context-active span rather than `getLastActiveTraceId()`: the
 * latter is only populated when a root span *ends* (on export), so mid-turn it
 * returns the previous turn's id — or, under concurrent turns, another turn's.
 */
export function currentTraceId(): string | undefined {
  if (!enabled || !mlflow) return undefined;
  try {
    return mlflow.getCurrentActiveSpan()?.traceId;
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

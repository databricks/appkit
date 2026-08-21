import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { createLogger } from "../../logging/logger";
import { TelemetryManager } from "../../telemetry";

const logger = createLogger("agents");

type MlflowModule = typeof import("mlflow-tracing");

interface MlflowInitConfig {
  trackingUri: string;
  experimentId: string;
  host?: string;
}

let mlflow: MlflowModule | undefined;
let enabled = false;
let initStarted = false;
let configured = false;
let initConfig: MlflowInitConfig | undefined;
let gatedProcessor: GatedMlflowSpanProcessor | undefined;

/**
 * Wraps mlflow's OTel `SpanProcessor` so it stays inert until mlflow's global
 * config is seeded. mlflow's `onStart` calls its own `getConfig()`, which THROWS
 * before `init()` runs — and that throw propagates out of `tracer.startSpan()`,
 * so it would break unrelated AppKit spans (HTTP, analytics) created between
 * `TelemetryManager.start()` and the first agent turn. We contribute this to
 * AppKit's single tracer provider during `setup()`, but only start forwarding
 * once `ready()` is called — right after the lazy `init()` in {@link ensureConfigured}.
 */
export class GatedMlflowSpanProcessor implements SpanProcessor {
  #inner: SpanProcessor;
  #ready = false;
  // Spans we forwarded `onStart` for, so `onEnd` stays balanced — mlflow never
  // sees an end without a matching start.
  #forwarded = new WeakSet<object>();

  constructor(inner: SpanProcessor) {
    this.#inner = inner;
  }

  ready(): void {
    this.#ready = true;
  }

  onStart(
    span: Parameters<SpanProcessor["onStart"]>[0],
    parentContext: Parameters<SpanProcessor["onStart"]>[1],
  ): void {
    if (!this.#ready) return;
    this.#forwarded.add(span);
    this.#inner.onStart(span, parentContext);
  }

  onEnd(span: Parameters<SpanProcessor["onEnd"]>[0]): void {
    if (!this.#forwarded.has(span)) return;
    this.#inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }
}

/**
 * Build mlflow's OTel `SpanProcessor` ourselves rather than letting `init()`
 * build and globally register its own tracer provider. This lets AppKit own the
 * single global provider (OTLP + this processor), so agent spans reach both
 * MLflow and any OTLP endpoint without two SDKs racing for the global slot.
 *
 * Deep-imports `mlflow-tracing` internals that aren't on its public entrypoint —
 * pinned to the exact version in package.json and guarded by a test that fails
 * loudly if a version bump renames them.
 */
async function buildMlflowSpanProcessor(
  config: MlflowInitConfig,
): Promise<SpanProcessor> {
  const { createAuthProvider } = await import("mlflow-tracing/dist/auth");
  const { MlflowClient } = await import("mlflow-tracing");
  const { MlflowSpanExporter, MlflowSpanProcessor } =
    await import("mlflow-tracing/dist/exporters/mlflow");

  const authProvider = createAuthProvider({
    trackingUri: config.trackingUri,
    ...(config.host ? { host: config.host } : {}),
  });
  const client = new MlflowClient({
    trackingUri: config.trackingUri,
    authProvider,
  });
  // mlflow builds against a different @opentelemetry/sdk-trace-base major than
  // AppKit; the SpanProcessor contract (onStart/onEnd/forceFlush/shutdown) is
  // stable across them, so bridge the nominal type mismatch with one cast.
  return new MlflowSpanProcessor(
    new MlflowSpanExporter(client),
  ) as unknown as SpanProcessor;
}

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
 * Called from the agents plugin's `setup()`, before `TelemetryManager.start()`.
 *
 * Rather than let `mlflow.init()` stand up and globally register its own tracer
 * provider (which would race AppKit's and drop one exporter), we build mlflow's
 * span processor ourselves and contribute it to AppKit's single provider via
 * {@link TelemetryManager.registerSpanProcessor}. mlflow's global config is
 * seeded lazily in {@link ensureConfigured} on first trace, after `start()`.
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
    initConfig = {
      trackingUri: process.env.MLFLOW_TRACKING_URI?.trim() || "databricks",
      experimentId: id,
      ...(host ? { host } : {}),
    };
    const processor = await buildMlflowSpanProcessor(initConfig);
    gatedProcessor = new GatedMlflowSpanProcessor(processor);
    TelemetryManager.registerSpanProcessor(gatedProcessor);
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
 * Seed mlflow's global config on first use — AFTER `TelemetryManager.start()`
 * has registered AppKit's provider. `init()` also stands up its own tracer
 * provider and tries to register it globally, but that loses to AppKit's
 * already-registered provider (non-fatal); we call it only for the config
 * side-effect mlflow's span processor requires, then enable forwarding on the
 * gated processor. Returns whether tracing is usable.
 */
function ensureConfigured(): boolean {
  if (configured) return enabled;
  configured = true;
  if (!mlflow || !initConfig) return false;
  try {
    mlflow.init(initConfig);
    gatedProcessor?.ready();
    return true;
  } catch (err) {
    enabled = false;
    logger.warn("MLflow agent tracing disabled (init failed): %O", err);
    return false;
  }
}

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
  const m = mlflow;
  if (!ensureConfigured()) return fn(noopRecorder);
  const type = spanType === "AGENT" ? m.SpanType.AGENT : m.SpanType.TOOL;
  return await m.withSpan<T>(
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

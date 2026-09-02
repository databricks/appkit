import type { UnityCatalogLocation } from "@mlflow/core";
import { SpanKind } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { createLogger } from "../../logging/logger";
import { TelemetryManager } from "../../telemetry";

const logger = createLogger("agents");

type MlflowModule = typeof import("@mlflow/core");
type MlflowClientInstance = InstanceType<MlflowModule["MlflowClient"]>;

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
// The resolved UC trace location, or undefined for classic experiment storage.
let ucLocation: UnityCatalogLocation | undefined;
let gatedProcessor: GatedMlflowSpanProcessor | undefined;

/**
 * Wraps mlflow's OTel `SpanProcessor` and scopes it to agent traces. Two jobs:
 *
 * 1. Stay inert until ready. The classic processor's `onStart` calls its own
 *    `getConfig()`, which THROWS before `init()` runs — and that throw
 *    propagates out of `tracer.startSpan()`, so it would break unrelated AppKit
 *    spans (HTTP, analytics) created between `TelemetryManager.start()` and the
 *    first agent turn. We contribute this to AppKit's single tracer provider
 *    during `setup()`, but only start forwarding once `ready()` is called by
 *    {@link ensureConfigured}. (The UC processor reads no global config and
 *    can't throw here, but forwarding is gated uniformly either way.)
 *
 * 2. Let only agent turns become MLflow traces. mlflow roots a trace at EVERY
 *    parentless span, and AppKit's single provider carries every HTTP/DB span —
 *    so unscoped, every request would become an MLflow trace. mlflow stamps
 *    `mlflow.spanType` on EVERY span it processes (defaulting to `UNKNOWN`), so
 *    presence alone can't tell an agent turn from a plain request — we key on
 *    the value (AGENT/TOOL) instead. At the root's `onEnd` we forward it (mlflow
 *    exports the trace) only if some span in the trace carried an AGENT/TOOL
 *    type; otherwise `popTrace` to discard the trace mlflow built in memory. The
 *    real span type is set after `onStart` (the constructor stamps UNKNOWN
 *    first), and children end before their root, so the flag is set by the time
 *    the root decides.
 *
 * It also drops the exporters' own outbound spans at `onStart` (parentless
 * CLIENT — outgoing requests made outside any agent turn, e.g. mlflow/OTLP
 * shipping a trace). Forwarding those would loop: each upload is an HTTP call
 * that auto-instrumentation turns into a new span to trace and upload.
 *
 * ponytail: non-agent requests still build (then discard) an in-memory trace
 * tree — allocation-only, no network (export happens only when we forward the
 * root's `onEnd`). Fine at normal QPS; if a very high-QPS app makes the churn
 * matter, root MLflow at a detached agent span instead (costs the HTTP envelope
 * on the trace and splits the OTLP trace).
 */
export class GatedMlflowSpanProcessor implements SpanProcessor {
  #inner: SpanProcessor;
  #ready = false;
  // Spans we forwarded `onStart` for, so `onEnd` stays balanced — mlflow never
  // sees an end without a matching start.
  #forwarded = new WeakSet<object>();
  // OTel trace ids that contained at least one mlflow (AGENT/TOOL) span, so the
  // root's `onEnd` exports rather than discards. Cleared as each root ends.
  #agentTraceIds = new Set<string>();
  #popTrace: (otelTraceId: string) => void;
  #spanTypeKey: string;
  // The `mlflow.spanType` attribute values (JSON-stringified) that mark a trace
  // as an agent turn — AGENT/TOOL. Every other value (notably UNKNOWN, which
  // mlflow stamps on all non-agent spans) is treated as non-agent.
  #agentSpanTypes: ReadonlySet<string>;
  // Leak backstop for #agentTraceIds — far above real concurrency. See onEnd.
  #maxTracked: number;
  // Cap on how long forceFlush/shutdown wait for a stuck export.
  #flushTimeoutMs: number;

  constructor(
    inner: SpanProcessor,
    deps: {
      popTrace: (otelTraceId: string) => void;
      spanTypeKey: string;
      agentSpanTypes: ReadonlySet<string>;
      maxTracked?: number;
      flushTimeoutMs?: number;
    },
  ) {
    this.#inner = inner;
    this.#popTrace = deps.popTrace;
    this.#spanTypeKey = deps.spanTypeKey;
    this.#agentSpanTypes = deps.agentSpanTypes;
    this.#maxTracked = deps.maxTracked ?? 1024;
    this.#flushTimeoutMs = deps.flushTimeoutMs ?? 5000;
  }

  ready(): void {
    this.#ready = true;
  }

  onStart(
    span: Parameters<SpanProcessor["onStart"]>[0],
    parentContext: Parameters<SpanProcessor["onStart"]>[1],
  ): void {
    if (!this.#ready) return;
    // Drop the exporters' own outbound calls. A parentless (root) CLIENT span is
    // an outgoing request made outside any agent turn — e.g. mlflow or OTLP
    // shipping a trace. Forwarding those would loop: each upload is itself an
    // HTTP call that auto-instrumentation turns into a new span to trace and
    // upload.
    if (span.kind === SpanKind.CLIENT && !span.parentSpanContext?.spanId) {
      return;
    }
    this.#forwarded.add(span);
    this.#inner.onStart(span, parentContext);
  }

  onEnd(span: Parameters<SpanProcessor["onEnd"]>[0]): void {
    if (!this.#forwarded.has(span)) return;
    const traceId = span.spanContext().traceId;
    // An AGENT/TOOL span ended in this trace — mark it for export. mlflow stamps
    // `mlflow.spanType` on every span (UNKNOWN by default), so match the value,
    // not mere presence; the real type is set after `onStart`, so `onEnd` is the
    // earliest we can read it.
    if (
      this.#agentSpanTypes.has(span.attributes[this.#spanTypeKey] as string) &&
      !this.#agentTraceIds.has(traceId)
    ) {
      // Normally an entry lives only until its root's onEnd deletes it. But a
      // root that ends BEFORE its agent child (streaming client-disconnect) or
      // never ends (crash) orphans the entry, and #agentTraceIds — unlike the
      // GC-safe #forwarded WeakSet — is keyed by string, so it can't self-clean.
      // FIFO-evict at the cap so an abandoned-trace pattern can't grow it
      // unboundedly over process uptime.
      // ponytail: evicting a still-live trace only mis-discards it, and that
      // needs >#maxTracked concurrent agent turns — far above real load.
      if (this.#agentTraceIds.size >= this.#maxTracked) {
        const oldest = this.#agentTraceIds.values().next().value;
        if (oldest !== undefined) this.#agentTraceIds.delete(oldest);
      }
      this.#agentTraceIds.add(traceId);
    }
    if (span.parentSpanContext?.spanId) {
      // Non-root: mlflow's own `onEnd` early-returns, but forward for balance.
      this.#inner.onEnd(span);
      return;
    }
    // Root span: export only agent traces; discard everything else so plain HTTP
    // requests never become MLflow traces. `delete` reports whether it was agent.
    if (this.#agentTraceIds.delete(traceId)) {
      this.#inner.onEnd(span);
    } else {
      this.#popTrace(traceId);
    }
  }

  forceFlush(): Promise<void> {
    return this.#boundedFlush(() => this.#inner.forceFlush());
  }

  shutdown(): Promise<void> {
    return this.#boundedFlush(() => this.#inner.shutdown());
  }

  // Bound the inner flush/shutdown wait: both exporters export fire-and-forget,
  // so a stuck export only wedges here (graceful shutdown), never a turn.
  // Resolves — not rejects — on timeout: the caller is tearing down.
  async #boundedFlush(op: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        op().catch((err) => {
          logger.warn("MLflow trace flush error: %O", err);
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn(
              "MLflow trace flush exceeded %dms; continuing (export may still be in flight)",
              this.#flushTimeoutMs,
            );
            resolve();
          }, this.#flushTimeoutMs);
          timer.unref(); // don't keep the event loop alive on the timeout alone
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Resolve the Unity Catalog trace location for the bound experiment, or
 * `undefined` for classic experiment-backed storage. Any failure falls back to
 * classic — a tracing misconfiguration must never break the agent.
 *
 * 1. Explicit env override — `MLFLOW_UC_CATALOG` + `MLFLOW_UC_SCHEMA` +
 *    `MLFLOW_UC_TABLE_PREFIX`, all three required.
 * 2. Auto-detect from the linked Databricks experiment (numeric ids only, since
 *    `GetExperiment` only accepts them): parse its `databricksTrace*` tags with
 *    mlflow's own {@link ucLocationFromExperimentTags}, which also carries the
 *    backend-populated spans/logs table names for custom-provisioned locations.
 * 3. Otherwise classic.
 *
 * `ucLocationFromExperimentTags` isn't on `@mlflow/core`'s public entrypoint, so
 * it's deep-imported like the exporter classes and covered by the tripwire test.
 */
async function resolveUcLocation(
  experimentId: string,
  client: MlflowClientInstance,
): Promise<UnityCatalogLocation | undefined> {
  const catalogName = process.env.MLFLOW_UC_CATALOG?.trim();
  const schemaName = process.env.MLFLOW_UC_SCHEMA?.trim();
  const tablePrefix = process.env.MLFLOW_UC_TABLE_PREFIX?.trim();
  if (catalogName && schemaName && tablePrefix) {
    return { catalogName, schemaName, tablePrefix };
  }

  if (!/^\d+$/.test(experimentId)) return undefined;

  try {
    const experiment = await client.getExperiment(experimentId);
    if (!experiment) return undefined;
    const { ucLocationFromExperimentTags } =
      await import("@mlflow/core/dist/core/destination");
    return ucLocationFromExperimentTags(experiment.tags) ?? undefined;
  } catch (err) {
    logger.warn(
      "MLflow UC trace-location auto-detect failed; using classic experiment storage: %O",
      err,
    );
    return undefined;
  }
}

/**
 * Build mlflow's OTel `SpanProcessor` ourselves rather than letting `init()`
 * build and globally register its own tracer provider (its own `NodeSDK`). This
 * lets AppKit own the single global provider (OTLP + this processor), so agent
 * spans reach both MLflow and any OTLP endpoint without two SDKs racing for the
 * global slot.
 *
 * When a UC trace location is bound, builds the Unity Catalog processor +
 * exporter (V4 trace ids, spans uploaded to the experiment's UC table);
 * otherwise the classic experiment-backed processor. `createAuthProvider`,
 * `MlflowClient`, `InMemoryTraceManager` and `SpanAttributeKey` are all public
 * in `@mlflow/core`, so only the exporter/processor classes are deep-imported —
 * pinned to the exact version in package.json and guarded by a test that fails
 * loudly if a version bump renames them.
 *
 * Also resolves the hooks {@link GatedMlflowSpanProcessor} needs to scope
 * forwarding to agent traces: `popTrace` (to discard non-agent traces), the
 * `mlflow.spanType` attribute key, and the JSON-stringified AGENT/TOOL values
 * that mark a trace as an agent turn (mlflow stamps every span, defaulting to
 * UNKNOWN, so the gate must match the value, not presence).
 */
async function buildMlflowSpanProcessor(
  m: MlflowModule,
  client: MlflowClientInstance,
  ucLoc: UnityCatalogLocation | undefined,
): Promise<{
  processor: SpanProcessor;
  popTrace: (otelTraceId: string) => void;
  spanTypeKey: string;
  agentSpanTypes: ReadonlySet<string>;
}> {
  let processor: SpanProcessor;
  if (ucLoc) {
    const { DatabricksUCTableSpanExporter, DatabricksUCTableSpanProcessor } =
      await import("@mlflow/core/dist/exporters/uc_table");
    processor = new DatabricksUCTableSpanProcessor(
      new DatabricksUCTableSpanExporter(client),
      ucLoc,
    );
  } else {
    const { MlflowSpanExporter, MlflowSpanProcessor } =
      await import("@mlflow/core/dist/exporters/mlflow");
    processor = new MlflowSpanProcessor(new MlflowSpanExporter(client));
  }
  return {
    processor,
    popTrace: (otelTraceId) =>
      m.InMemoryTraceManager.getInstance().popTrace(otelTraceId),
    spanTypeKey: m.SpanAttributeKey.SPAN_TYPE,
    // mlflow JSON-stringifies attribute values, so the stored values are
    // `"AGENT"`/`"TOOL"` (quoted). Match that exact form.
    agentSpanTypes: new Set([
      JSON.stringify(m.SpanType.AGENT),
      JSON.stringify(m.SpanType.TOOL),
    ]),
  };
}

/** The bound MLflow experiment id, from the optional `experiment` resource. */
function experimentId(): string | undefined {
  const id = process.env.MLFLOW_EXPERIMENT_ID?.trim();
  return id || undefined;
}

/**
 * Databricks host with a scheme. `@mlflow/core` uses `DATABRICKS_HOST`
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
 * Rather than let `@mlflow/core`'s `init()` stand up and globally register its
 * own tracer provider (its `NodeSDK`, which would race AppKit's), we build the
 * span processor ourselves and contribute it to AppKit's single provider via
 * {@link TelemetryManager.registerSpanProcessor}. For the classic
 * experiment-backed processor, mlflow's global config is seeded by
 * {@link startAgentTracing} on the `"setup:complete"` lifecycle event (after
 * `start()`), with {@link ensureConfigured} as an idempotent lazy fallback; the
 * UC processor needs no seeded config, so that path never calls `init()`.
 *
 * The trace store is resolved here: a UC table prefix (env-configured or
 * auto-detected from the experiment's Databricks tags) vs. the classic
 * experiment. Auth is resolved by `@mlflow/core` from the app's own Databricks
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
    mlflow = await import("@mlflow/core");
    const host = normalizedDatabricksHost();
    initConfig = {
      trackingUri: process.env.MLFLOW_TRACKING_URI?.trim() || "databricks",
      experimentId: id,
      ...(host ? { host } : {}),
    };
    // One auth resolution + client, reused for UC auto-detect and the exporter.
    const authProvider = mlflow.createAuthProvider({
      trackingUri: initConfig.trackingUri,
      ...(host ? { host } : {}),
    });
    const client = new mlflow.MlflowClient({
      trackingUri: initConfig.trackingUri,
      authProvider,
    });
    ucLocation = await resolveUcLocation(id, client);
    const { processor, popTrace, spanTypeKey, agentSpanTypes } =
      await buildMlflowSpanProcessor(mlflow, client, ucLocation);
    gatedProcessor = new GatedMlflowSpanProcessor(processor, {
      popTrace,
      spanTypeKey,
      agentSpanTypes,
    });
    TelemetryManager.registerSpanProcessor(gatedProcessor);
    enabled = true;
    if (ucLocation) {
      logger.info(
        "MLflow agent tracing enabled (experiment %s, UC %s.%s.%s)",
        id,
        ucLocation.catalogName,
        ucLocation.schemaName,
        ucLocation.tablePrefix,
      );
    } else {
      logger.info("MLflow agent tracing enabled (experiment %s)", id);
    }
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
 * Seed the classic processor's global config once, AFTER
 * `TelemetryManager.start()` has registered AppKit's provider — driven eagerly
 * by {@link startAgentTracing} on `"setup:complete"`, or lazily by {@link trace}
 * as a fallback — then enable forwarding on the gated processor. Returns whether
 * tracing is usable.
 *
 * The classic experiment-backed `MlflowSpanProcessor` reads
 * `getConfig().experimentId` in `onStart`, so it needs `init()` to seed mlflow's
 * global config. `init()` also stands up its own `NodeSDK` whose provider loses
 * the global slot to AppKit's already-registered one (non-fatal); we call it
 * only for that config side-effect. The UC processor carries its location and
 * reads no global config, so the UC path skips `init()` entirely — no second
 * `NodeSDK`, no competing global registration by `@mlflow/core`.
 */
function ensureConfigured(): boolean {
  if (configured) return enabled;
  configured = true;
  // `gatedProcessor` guard is load-bearing: if buildMlflowSpanProcessor threw,
  // `mlflow` and `initConfig` are still set but there is no gate. Calling
  // `mlflow.init()` then would stand up mlflow's OWN ungated provider — and if
  // AppKit registered none (no OTLP, no processor) it wins the global slot,
  // routing every span into mlflow un-gated: the exact over-tracing + exporter
  // loop this file exists to prevent.
  if (!mlflow || !initConfig || !gatedProcessor) return false;
  try {
    if (!ucLocation) mlflow.init(initConfig);
    gatedProcessor.ready();
    return true;
  } catch (err) {
    enabled = false;
    logger.warn("MLflow agent tracing disabled (init failed): %O", err);
    return false;
  }
}

/**
 * Seed mlflow's config eagerly, right after `TelemetryManager.start()` — the
 * agents plugin wires this to the `"setup:complete"` lifecycle event, before the
 * server serves any request. Doing it here means the request's own root span is
 * already forwarded when the first turn runs, so that turn assembles into a
 * trace instead of being dropped (mlflow roots a trace only at the top-level
 * span). Idempotent. `trace()` also seeds lazily, but that only fully rescues a
 * turn whose agent span is itself the trace root; an HTTP-wrapped first turn
 * seeded lazily loses its root span (already started — and dropped — before
 * `ready()`), so this eager path is the reliable one.
 */
export function startAgentTracing(): void {
  ensureConfigured();
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

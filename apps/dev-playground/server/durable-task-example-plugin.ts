/**
 * Durable Task Example — showcases TaskFlow's two recovery patterns.
 *
 * Two tasks are registered:
 *
 *   `count-to-n` — manual recovery via `ctx.previousEvents`. The handler
 *     ticks once per `sleepMs`, emitting `tick` events. On recovery, it
 *     scans the event log to find the last persisted tick and resumes
 *     from there. Use this pattern when a checkpoint is "the last time
 *     I emitted X" and there's no expensive computation to memoize.
 *
 *   `pipeline-with-steps` — automatic recovery via `step()`. Each stage
 *     (extract → transform → load) is wrapped with `step()`, which
 *     memoizes its result in the WAL the first time it runs. On
 *     recovery, completed stages return their cached value without
 *     re-executing. Use this pattern when stages are expensive (LLM
 *     calls, large queries, network I/O) and replay is unsafe.
 *
 * Routes (mounted under `/api/durable-example`):
 *   POST /run                 — start a `count-to-n` run, bridges SSE.
 *   POST /run-pipeline        — start a `pipeline-with-steps` run, bridges SSE.
 *   POST /crash/:id           — `simulateCrash` for the task with idempotencyKey :id.
 *   POST /stop/:id            — cooperative cancel via `task.stop()`.
 *   POST /nudge-recovery      — re-`start()` with the same body as the
 *                               original run (same input ⇒ same engine IK).
 *                               Triggers stale-Running recovery after a
 *                               `simulateCrash`; unlike `engine.resume()`
 *                               which only applies to **Suspended** tasks.
 *   GET  /reattach/:id        — bridge an SSE stream onto an existing run
 *                               by IK (uses `subscribe` directly because
 *                               `executeTask` would derive a new IK from
 *                               this synthetic input).
 *
 * The frontend route at `/durable-task` exercises all of the above.
 */
import {
  Plugin,
  type PluginManifest,
  setupSseHeaders,
  step,
  type TaskContext,
  type TypedTaskContext,
  toPlugin,
  writeSseFrame,
} from "@databricks/appkit";
import type { IAppRouter } from "shared";

const TASKS = {
  countToN: "count-to-n",
  pipeline: "pipeline-with-steps",
} as const;
type TaskName = (typeof TASKS)[keyof typeof TASKS];

// Names the TaskFlow SSE bridge writes itself (or the engine emits).
// A user `ctx.emit("completed", …)` would otherwise round-trip on the
// wire as `event: completed` and trigger the EventSource close path.
// Mirror this in any hand-rolled bridge (see `/reattach/:id` below).
const BRIDGE_RESERVED = new Set<string>([
  "ready",
  "error",
  "heartbeat",
  "completed",
  "failed",
  "cancelled",
  "suspended",
]);

// ── count-to-n ─────────────────────────────────────────────────────────

interface CountInput {
  /**
   * Caller-chosen discriminator. Becomes part of the input the engine
   * hashes into the idempotency key, so two clicks with the same `runKey`
   * dedup to the same task and a different `runKey` produces a fresh run.
   */
  runKey: string;
  n: number;
  sleepMs: number;
}

interface CountEvents extends Record<string, unknown> {
  tick: { value: number; total: number };
  recovered: { resumed_from: number };
}

// ── pipeline-with-steps ────────────────────────────────────────────────

interface PipelineInput {
  runKey: string;
  /** Per-stage delay (ms). Held above the stale threshold so that
   * `simulateCrash` mid-stage exercises the cached-step recovery. */
  stageMs: number;
}

interface ExtractResult {
  sourceId: string;
  rows: number;
}
interface TransformResult {
  rows: number;
  sum: number;
}
interface LoadResult {
  rows: number;
  sum: number;
  destinationId: string;
}

interface PipelineEvents extends Record<string, unknown> {
  stage_started: { stage: "extract" | "transform" | "load" };
  stage_completed: {
    stage: "extract" | "transform" | "load";
    /** Payload is the cached return value of the step. */
    result: ExtractResult | TransformResult | LoadResult;
    /** True when the engine returned the cached result instead of
     * re-running the body — observable on recovery. */
    fromCache?: boolean;
  };
}

// `step()` is a higher-order wrapper: it takes `(ctx, ...args) =>
// Promise<T>` and returns a memoized version with the same shape. The
// first invocation runs the body and writes the result into the WAL
// under a step-specific key (the function name); later invocations
// (replay or recovery) short-circuit to the cached value. We use the
// explicit-name overload so the WAL key is stable across minifiers
// and refactors that might rename the surrounding `const`.
const extract = step(
  "extract",
  async (_ctx: TaskContext, sourceId: string): Promise<ExtractResult> => {
    return { sourceId, rows: 100 };
  },
);

const transform = step(
  "transform",
  async (_ctx: TaskContext, input: ExtractResult): Promise<TransformResult> => {
    let sum = 0;
    for (let i = 0; i < input.rows; i++) sum += i;
    return { rows: input.rows, sum };
  },
);

const load = step(
  "load",
  async (
    _ctx: TaskContext,
    input: TransformResult,
    destinationId: string,
  ): Promise<LoadResult> => {
    return { ...input, destinationId };
  },
);

export class DurableTaskExamplePlugin extends Plugin {
  static manifest = {
    name: "durable-example",
    displayName: "Durable Task Example",
    description:
      "Demonstrates this.executeTask + two recovery patterns (manual via previousEvents and automatic via step()).",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"durable-example">;

  /**
   * Returns the live task manager or throws. The whole demo presumes
   * durable execution is on; failing fast keeps the routes' error
   * paths short.
   */
  private requireTask() {
    if (!this.task) {
      throw new Error(
        "Durable task example requires `task` enabled; this app was created with `task: false`.",
      );
    }
    return this.task;
  }

  async setup(): Promise<void> {
    const manager = this.requireTask();

    manager.task<CountInput, { final: number }, CountEvents>({
      name: TASKS.countToN,
      execute: (input, ctx) => this.countToN(input, ctx),
      autoRecover: true,
    });

    manager.task<PipelineInput, LoadResult, PipelineEvents>({
      name: TASKS.pipeline,
      execute: (input, ctx) => this.pipelineWithSteps(input, ctx),
      autoRecover: true,
    });
  }

  /**
   * Count-to-N — manual recovery pattern.
   *
   * Body emits `tick` once per `sleepMs`. On recovery, scans the event
   * log to find the last persisted `tick` and resumes from there.
   * Demonstrates `ctx.previousEvents` + `ctx.isRecovery`.
   */
  private async countToN(
    input: CountInput,
    ctx: TypedTaskContext<CountEvents>,
  ): Promise<{ final: number }> {
    let start = 0;

    if (ctx.isRecovery) {
      // Walk previousEvents from the tail looking for the last `tick`.
      // `Array.prototype.findLast` would be cleaner but is ES2023; the
      // root tsconfig targets ES2022 so we do the loop by hand.
      let lastTick: (typeof ctx.previousEvents)[number] | undefined;
      for (let i = ctx.previousEvents.length - 1; i >= 0; i--) {
        const e = ctx.previousEvents[i];
        if (e?.eventType === "custom:tick") {
          lastTick = e;
          break;
        }
      }
      const lastValue =
        lastTick?.payload && typeof lastTick.payload === "object"
          ? Number((lastTick.payload as CountEvents["tick"]).value)
          : NaN;
      if (Number.isFinite(lastValue)) {
        start = lastValue + 1;
        await ctx.emit("recovered", { resumed_from: start });
      }
    }

    for (let value = start; value <= input.n; value++) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(50, input.sleepMs)),
      );
      await ctx.emit("tick", { value, total: input.n });
    }

    return { final: input.n };
  }

  /**
   * Pipeline-with-steps — automatic recovery pattern.
   *
   * Three stages chained as `step()`s. After a crash:
   *   - Stages that already wrote their result to the WAL replay
   *     instantly with the cached value (no rerun).
   *   - The first stage that hadn't completed runs from scratch.
   *   - Subsequent stages run for the first time as usual.
   *
   * The `stage_completed` event carries `fromCache: true` for replays
   * so the frontend can tell apart "ran fresh" from "resumed".
   * `ctx.previousEvents` is consulted only for that UI cue — `step()`
   * itself does the heavy lifting silently.
   */
  private async pipelineWithSteps(
    input: PipelineInput,
    ctx: TypedTaskContext<PipelineEvents>,
  ): Promise<LoadResult> {
    const stageMs = Math.max(50, input.stageMs);

    const wasCompleted = (stage: PipelineEvents["stage_started"]["stage"]) =>
      ctx.isRecovery &&
      ctx.previousEvents.some(
        (e) =>
          e?.eventType === "custom:stage_completed" &&
          (e?.payload as PipelineEvents["stage_completed"] | undefined)
            ?.stage === stage,
      );

    await ctx.emit("stage_started", { stage: "extract" });
    const extractCached = wasCompleted("extract");
    if (!extractCached) await sleep(stageMs);
    const extracted = await extract(ctx, input.runKey);
    await ctx.emit("stage_completed", {
      stage: "extract",
      result: extracted,
      fromCache: extractCached,
    });

    await ctx.emit("stage_started", { stage: "transform" });
    const transformCached = wasCompleted("transform");
    if (!transformCached) await sleep(stageMs);
    const transformed = await transform(ctx, extracted);
    await ctx.emit("stage_completed", {
      stage: "transform",
      result: transformed,
      fromCache: transformCached,
    });

    await ctx.emit("stage_started", { stage: "load" });
    const loadCached = wasCompleted("load");
    if (!loadCached) await sleep(stageMs);
    const loaded = await load(ctx, transformed, `dest-${input.runKey}`);
    await ctx.emit("stage_completed", {
      stage: "load",
      result: loaded,
      fromCache: loadCached,
    });

    return loaded;
  }

  injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "run",
      method: "post",
      path: "/run",
      handler: async (req, res) => {
        const input = parseCountInput(req.body);
        // The engine derives the IK from sha256(taskName, input, userId).
        // The client reads it from the `X-AppKit-Task-Idempotency-Key`
        // response header (or the first SSE `ready` event).
        await this.executeTask(res, TASKS.countToN, input);
      },
    });

    this.route(router, {
      name: "run-pipeline",
      method: "post",
      path: "/run-pipeline",
      handler: async (req, res) => {
        const input = parsePipelineInput(req.body);
        await this.executeTask(res, TASKS.pipeline, input);
      },
    });

    // `simulateCrash` is a test-mode primitive that aborts the executor
    // mid-run. Exposing it on a public route in production would let any
    // caller crash any in-flight task by guessing its IK (the IK is
    // content-addressed, so colleagues who know the input can derive it).
    // The dev-playground sets `enableTestMode: true` to demo recovery,
    // which is itself dev-only. Gating the route here means a copy-paste
    // of this plugin into a real app does not silently expose the crash
    // verb if NODE_ENV is set.
    this.route(router, {
      name: "crash",
      method: "post",
      path: "/crash/:id",
      handler: async (req, res) => {
        if (process.env.NODE_ENV === "production") {
          res.status(404).json({ error: "Not found" });
          return;
        }
        const id = String(req.params.id);
        try {
          this.requireTask().simulateCrash(id);
          res.json({ crashed: true, idempotencyKey: id });
        } catch (err) {
          res.status(400).json({ error: errorMessage(err) });
        }
      },
    });

    this.route(router, {
      name: "stop",
      method: "post",
      path: "/stop/:id",
      handler: async (req, res) => {
        const id = String(req.params.id);
        const reason =
          typeof req.body?.reason === "string"
            ? req.body.reason
            : "user_requested";
        try {
          await this.requireTask().stop(id, { reason });
          res.json({ stopped: true, idempotencyKey: id, reason });
        } catch (err) {
          res.status(400).json({ error: errorMessage(err) });
        }
      },
    });

    this.route(router, {
      name: "nudge-recovery",
      method: "post",
      path: "/nudge-recovery",
      handler: async (req, res) => {
        // Re-`start()` with the **same** input as the original run so the
        // engine derives the same IK and re-spawns the existing
        // (stale-Running) task. Without `userId` here for the same reason:
        // `/run` and `/run-pipeline` go through `executeTask`, which
        // resolves userId from the active `runInUserContext` scope (none
        // here ⇒ `undefined`). Passing a userId derived from
        // `x-forwarded-user` would produce a *different* IK and create a
        // fresh task instead of nudging the existing one.
        const taskName = parseTaskName(req.body?.taskName) ?? TASKS.countToN;
        const input =
          taskName === TASKS.pipeline
            ? parsePipelineInput(req.body)
            : parseCountInput(req.body);
        try {
          const handle = await this.requireTask().start(taskName, input);
          res.json({
            ok: true,
            taskName,
            idempotencyKey: handle.idempotencyKey,
          });
        } catch (err) {
          res.status(400).json({ error: errorMessage(err) });
        }
      },
    });

    this.route(router, {
      name: "reattach",
      method: "get",
      path: "/reattach/:id",
      handler: async (req, res) => {
        // Bridge an SSE stream onto an existing run by IK. We don't use
        // `executeTask` because the engine would derive a *new* IK from
        // this (synthetic) input — instead we go straight to
        // `subscribe` and bridge events ourselves, reusing
        // `setupSseHeaders` / `writeSseFrame` so the wire format
        // (headers + framing) stays identical to `executeTask`.
        const id = String(req.params.id);
        const manager = this.requireTask();
        const lastSeq = parseLastEventId(req.header("last-event-id"));

        // Ownership / existence check: `manager.reconnect(ik, userId)`
        // returns null when the IK is unknown or the userId does not
        // match the task's recorded owner. Without this check, ANY
        // caller who can guess an IK (the IK is content-addressed —
        // colleagues can derive it from a known input shape) could
        // open this stream and read the task's events. The demo
        // intentionally has no auth in front of it, so we guard at the
        // route level and 404 ambiguously rather than 403 to avoid
        // confirming whether a given IK exists.
        const userId = req.header("x-forwarded-user");
        const owner = await manager.reconnect(id, userId);
        if (!owner) {
          res.status(404).json({ error: "Not found" });
          return;
        }

        setupSseHeaders(res);
        writeSseFrame(res, {
          event: "ready",
          data: JSON.stringify({ idempotencyKey: id }),
        });

        let closed = false;
        req.on("close", () => {
          closed = true;
        });

        try {
          for await (const evt of manager.subscribe(id, lastSeq)) {
            if (closed || res.writableEnded) break;
            const type = evt.event.eventType;
            if (type === "heartbeat") continue;
            if (typeof type === "string" && type.startsWith("custom:step:")) {
              continue;
            }
            const isCustom =
              typeof type === "string" && type.startsWith("custom:");
            const eventName = isCustom
              ? type.slice("custom:".length)
              : (type ?? "message");
            // Mirrors the `executeTask` bridge: refuse to forward a
            // user-emitted event whose name collides with bridge wire
            // vocabulary (would close the EventSource on the client
            // while the engine keeps publishing). Inlined here because
            // we are demonstrating a hand-rolled bridge.
            if (isCustom && BRIDGE_RESERVED.has(eventName)) {
              continue;
            }
            writeSseFrame(res, {
              id: evt.streamSeq,
              event: eventName,
              data: JSON.stringify(evt.event.payload ?? {}),
            });
            if (
              type === "completed" ||
              type === "failed" ||
              type === "cancelled"
            ) {
              break;
            }
          }
        } finally {
          if (!res.writableEnded) res.end();
        }
      },
    });
  }
}

export const durableTaskExample = toPlugin(DurableTaskExamplePlugin);

// ── helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return (err as { message?: string } | undefined)?.message ?? String(err);
}

// We deliberately route through `Record<string, unknown>` instead of
// `Partial<CountInput>`: the upstream `body: unknown` carries no
// guarantee that fields exist or have the expected types. `Partial<T>`
// would lie to TypeScript that `b.n` is `number | undefined` when the
// runtime might hand us `"10"` or `[]`. Reading via the loose record
// keeps every access honestly typed as `unknown` and forces the
// per-field validation the callers below already do.
function asObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}

function parseCountInput(body: unknown): CountInput {
  const b = asObject(body);
  const runKey = typeof b.runKey === "string" && b.runKey ? b.runKey : null;
  return {
    runKey: runKey ?? `run-${Date.now()}`,
    n: Number.isFinite(b.n) ? Number(b.n) : 10,
    sleepMs: Number.isFinite(b.sleepMs) ? Number(b.sleepMs) : 1000,
  };
}

function parsePipelineInput(body: unknown): PipelineInput {
  const b = asObject(body);
  const runKey = typeof b.runKey === "string" && b.runKey ? b.runKey : null;
  return {
    runKey: runKey ?? `pipeline-${Date.now()}`,
    stageMs: Number.isFinite(b.stageMs) ? Number(b.stageMs) : 2500,
  };
}

function parseTaskName(value: unknown): TaskName | undefined {
  if (value === TASKS.countToN || value === TASKS.pipeline) return value;
  return undefined;
}

function parseLastEventId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Durable Task Example — UI for `apps/dev-playground/server/durable-task-example-plugin.ts`.
 *
 * Demonstrates the AppKit `executeTask` flow end-to-end across two
 * tasks:
 *
 *   - `count-to-n`           manual recovery via `ctx.previousEvents`.
 *   - `pipeline-with-steps`  automatic recovery via `step()`.
 *
 * For each task the UI exercises:
 *   1. POST /run[-pipeline]                       starts and bridges SSE.
 *   2. POST /crash/:id                            simulates a process crash.
 *      `engine.resume()` only applies to Suspended tasks, so the demo
 *      uses a "nudge" instead — re-submit the same input so the engine
 *      recovers a stale Running row.
 *   3. POST /nudge-recovery { taskName, ... }     re-submits to trigger recovery.
 *   4. POST /stop/:id { reason }                  cooperative cancellation.
 *   5. GET  /reattach/:id                         re-attach SSE by IK.
 */

import { subscribeToTask } from "@databricks/appkit-ui/js";
import { Button } from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/durable-task")({
  component: DurableTaskRoute,
});

// ── shared types ──────────────────────────────────────────────────────

type LogEntry = {
  ts: number;
  kind:
    | "info"
    | "tick"
    | "stage"
    | "recovered"
    | "cached"
    | "cancelled"
    | "error"
    | "done";
  message: string;
};

type TaskKind = "count" | "pipeline";

interface CountEvents {
  tick: { value: number; total: number };
  recovered: { resumed_from: number };
}

type PipelineStage = "extract" | "transform" | "load";

interface PipelineEvents {
  stage_started: { stage: PipelineStage };
  stage_completed: {
    stage: PipelineStage;
    result: unknown;
    fromCache: boolean;
  };
}

interface CountResult {
  final: number;
}

interface PipelineResult {
  loadedTo: string;
  rows: number;
}

// ── component ─────────────────────────────────────────────────────────

function DurableTaskRoute() {
  const [taskKind, setTaskKind] = useState<TaskKind>("count");
  const [runKey, setRunKey] = useState<string>(() => makeRunKey());
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Per-task progress state.
  const [n, setN] = useState(20);
  const [sleepMs, setSleepMs] = useState(1000);
  const [progress, setProgress] = useState({ value: 0, total: 0 });
  const [recovered, setRecovered] = useState(false);

  const [stageProgress, setStageProgress] = useState<
    Record<
      PipelineStage,
      { state: "idle" | "running" | "done"; cached: boolean }
    >
  >({
    extract: { state: "idle", cached: false },
    transform: { state: "idle", cached: false },
    load: { state: "idle", cached: false },
  });

  const appendLog = useCallback((entry: Omit<LogEntry, "ts">) => {
    setLog((prev) => [...prev, { ...entry, ts: Date.now() }].slice(-200));
  }, []);

  const closeStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => closeStream, [closeStream]);

  const resetCountState = useCallback(() => {
    setProgress({ value: 0, total: 0 });
    setRecovered(false);
  }, []);

  const resetPipelineState = useCallback(() => {
    setStageProgress({
      extract: { state: "idle", cached: false },
      transform: { state: "idle", cached: false },
      load: { state: "idle", cached: false },
    });
  }, []);

  // ── SSE subscriptions ────────────────────────────────────────────

  const subscribeCount = useCallback(
    async (
      url: string,
      init: { method: "POST" | "GET"; payload?: unknown },
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      resetCountState();
      if (init.method === "POST") {
        setProgress((p) => ({ ...p, total: n }));
      }

      try {
        await subscribeToTask<CountEvents, CountResult>({
          url,
          ...(init.method === "POST"
            ? { payload: init.payload }
            : { payload: undefined }),
          signal: controller.signal,
          onReady: ({ idempotencyKey: ik }) => {
            setIdempotencyKey(ik);
            appendLog({ kind: "info", message: `idempotencyKey: ${ik}` });
          },
          onEvent: {
            tick: ({ value, total }) => {
              setProgress({ value, total });
              appendLog({ kind: "tick", message: `tick ${value} / ${total}` });
            },
            recovered: ({ resumed_from }) => {
              setRecovered(true);
              appendLog({
                kind: "recovered",
                message: `recovered, resumed from ${resumed_from}`,
              });
            },
          },
          onCompleted: (r) => {
            appendLog({
              kind: "done",
              message: `task completed (final=${r?.final ?? "?"})`,
            });
          },
          onFailed: (msg) =>
            appendLog({ kind: "error", message: `failed: ${msg}` }),
          onCancelled: () =>
            appendLog({ kind: "cancelled", message: "task cancelled" }),
          onError: (err) =>
            appendLog({
              kind: "error",
              message:
                (err as { message?: string } | undefined)?.message ??
                String(err),
            }),
        });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    },
    [appendLog, n, resetCountState],
  );

  const subscribePipeline = useCallback(
    async (
      url: string,
      init: { method: "POST" | "GET"; payload?: unknown },
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      resetPipelineState();

      try {
        await subscribeToTask<PipelineEvents, PipelineResult>({
          url,
          ...(init.method === "POST"
            ? { payload: init.payload }
            : { payload: undefined }),
          signal: controller.signal,
          onReady: ({ idempotencyKey: ik }) => {
            setIdempotencyKey(ik);
            appendLog({ kind: "info", message: `idempotencyKey: ${ik}` });
          },
          onEvent: {
            stage_started: ({ stage }) => {
              setStageProgress((s) => ({
                ...s,
                [stage]: { state: "running", cached: false },
              }));
              appendLog({ kind: "stage", message: `stage started: ${stage}` });
            },
            stage_completed: ({ stage, fromCache }) => {
              setStageProgress((s) => ({
                ...s,
                [stage]: { state: "done", cached: fromCache },
              }));
              appendLog({
                kind: fromCache ? "cached" : "stage",
                message: `stage completed: ${stage}${fromCache ? " (from cache)" : ""}`,
              });
            },
          },
          onCompleted: (r) => {
            appendLog({
              kind: "done",
              message: `pipeline completed (rows=${r?.rows ?? "?"} → ${r?.loadedTo ?? "?"})`,
            });
          },
          onFailed: (msg) =>
            appendLog({ kind: "error", message: `failed: ${msg}` }),
          onCancelled: () =>
            appendLog({ kind: "cancelled", message: "pipeline cancelled" }),
          onError: (err) =>
            appendLog({
              kind: "error",
              message:
                (err as { message?: string } | undefined)?.message ??
                String(err),
            }),
        });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    },
    [appendLog, resetPipelineState],
  );

  // ── handlers ──────────────────────────────────────────────────────

  const handleRun = useCallback(() => {
    closeStream();
    if (taskKind === "count") {
      void subscribeCount("/api/durable-example/run", {
        method: "POST",
        payload: { runKey, n, sleepMs },
      });
    } else {
      void subscribePipeline("/api/durable-example/run-pipeline", {
        method: "POST",
        payload: { runKey, sleepMs },
      });
    }
  }, [
    closeStream,
    taskKind,
    runKey,
    n,
    sleepMs,
    subscribeCount,
    subscribePipeline,
  ]);

  const handleReattach = useCallback(() => {
    if (!idempotencyKey) {
      appendLog({
        kind: "error",
        message: "no IK yet — run once before re-attaching",
      });
      return;
    }
    closeStream();
    const url = `/api/durable-example/reattach/${encodeURIComponent(idempotencyKey)}`;
    if (taskKind === "count") {
      void subscribeCount(url, { method: "GET" });
    } else {
      void subscribePipeline(url, { method: "GET" });
    }
  }, [
    appendLog,
    closeStream,
    idempotencyKey,
    subscribeCount,
    subscribePipeline,
    taskKind,
  ]);

  const handleCrash = useCallback(async () => {
    if (!idempotencyKey) {
      appendLog({ kind: "error", message: "no IK yet" });
      return;
    }
    appendLog({
      kind: "info",
      message: `simulating crash for ${idempotencyKey}`,
    });
    const res = await fetch(
      `/api/durable-example/crash/${encodeURIComponent(idempotencyKey)}`,
      { method: "POST" },
    );
    const data = (await res.json()) as { crashed?: boolean; error?: string };
    if (data.error) appendLog({ kind: "error", message: data.error });
  }, [idempotencyKey, appendLog]);

  const handleStop = useCallback(async () => {
    if (!idempotencyKey) {
      appendLog({ kind: "error", message: "no IK yet" });
      return;
    }
    appendLog({
      kind: "info",
      message: `requesting stop for ${idempotencyKey}`,
    });
    const res = await fetch(
      `/api/durable-example/stop/${encodeURIComponent(idempotencyKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user_requested" }),
      },
    );
    const data = (await res.json()) as { stopped?: boolean; error?: string };
    if (data.error) appendLog({ kind: "error", message: data.error });
  }, [idempotencyKey, appendLog]);

  const handleNudgeRecovery = useCallback(async () => {
    appendLog({
      kind: "info",
      message: `nudging recovery for ${taskKind} task`,
    });
    const body =
      taskKind === "count"
        ? { taskName: "count-to-n", runKey, n, sleepMs }
        : { taskName: "pipeline-with-steps", runKey, sleepMs };
    const res = await fetch("/api/durable-example/nudge-recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      idempotencyKey?: string;
    };
    if (data.error) {
      appendLog({ kind: "error", message: data.error });
      return;
    }
    if (
      idempotencyKey &&
      data.idempotencyKey &&
      data.idempotencyKey !== idempotencyKey
    ) {
      appendLog({
        kind: "error",
        message: `IK mismatch (expected ${idempotencyKey}, got ${data.idempotencyKey}) — check task / run key / params`,
      });
      return;
    }
    handleReattach();
  }, [appendLog, handleReattach, idempotencyKey, n, runKey, sleepMs, taskKind]);

  const handleNewRun = useCallback(() => {
    closeStream();
    setRunKey(makeRunKey());
    setIdempotencyKey(null);
    resetCountState();
    resetPipelineState();
    setLog([]);
  }, [closeStream, resetCountState, resetPipelineState]);

  const handleSwitchTask = useCallback(
    (next: TaskKind) => {
      if (next === taskKind || running) return;
      setTaskKind(next);
      setIdempotencyKey(null);
      resetCountState();
      resetPipelineState();
    },
    [taskKind, running, resetCountState, resetPipelineState],
  );

  const percent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.value / progress.total) * 100))
      : 0;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1200px] mx-auto px-6 py-12">
        <Header
          title="Durable Task Example"
          description="Demonstrates manual + automatic recovery, cooperative stop, and SSE re-attach via the durable-task bridge."
          tooltip="Powered by this.executeTask + the durable-task recovery worker + step()."
        />

        {/* Task selector */}
        <div className="bg-card border rounded-md p-2 my-6 inline-flex gap-1">
          <Button
            variant={taskKind === "count" ? "default" : "ghost"}
            size="sm"
            onClick={() => handleSwitchTask("count")}
            disabled={running}
          >
            count-to-n
          </Button>
          <Button
            variant={taskKind === "pipeline" ? "default" : "ghost"}
            size="sm"
            onClick={() => handleSwitchTask("pipeline")}
            disabled={running}
          >
            pipeline-with-steps
          </Button>
        </div>

        <div className="bg-card border rounded-md p-6 my-6 space-y-4">
          {/* Inputs */}
          <div className="grid grid-cols-3 gap-4">
            {taskKind === "count" && (
              <label className="text-sm">
                <div className="text-muted-foreground mb-1">Count to N</div>
                <input
                  type="number"
                  value={n}
                  min={1}
                  max={500}
                  onChange={(e) => setN(Number(e.target.value) || 1)}
                  disabled={running}
                  className="border rounded px-2 py-1 w-full"
                />
              </label>
            )}
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Sleep ms</div>
              <input
                type="number"
                value={sleepMs}
                min={50}
                max={10000}
                step={100}
                onChange={(e) => setSleepMs(Number(e.target.value) || 100)}
                disabled={running}
                className="border rounded px-2 py-1 w-full"
              />
            </label>
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">
                Run key
                <span className="text-xs text-muted-foreground/60 ml-1">
                  (input discriminator)
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={runKey}
                  onChange={(e) => setRunKey(e.target.value)}
                  disabled={running}
                  className="border rounded px-2 py-1 flex-1"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleNewRun}
                  disabled={running}
                >
                  new
                </Button>
              </div>
            </label>
          </div>

          <div className="text-xs font-mono text-muted-foreground">
            Idempotency key (engine-derived):{" "}
            <span className={idempotencyKey ? "text-foreground" : ""}>
              {idempotencyKey ?? "(will be issued on first run)"}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={handleRun} disabled={running}>
              {taskKind === "count" ? "Start counting" : "Run pipeline"}
            </Button>
            <Button
              onClick={handleReattach}
              variant="secondary"
              disabled={running}
            >
              Re-attach SSE
            </Button>
            <Button
              onClick={handleCrash}
              variant="destructive"
              disabled={!running}
            >
              Simulate crash
            </Button>
            <Button
              onClick={handleStop}
              variant="destructive"
              disabled={!running}
              title="Cooperative cancellation — emits cancelled event, no recovery."
            >
              Stop
            </Button>
            <Button
              onClick={handleNudgeRecovery}
              variant="secondary"
              title="Re-submit same input so the recovery worker handles stale Running (after simulate crash). Then re-attaches SSE."
            >
              Nudge recovery
            </Button>
            <Button onClick={closeStream} variant="ghost" disabled={!running}>
              Close stream
            </Button>
          </div>

          {/* Progress */}
          {taskKind === "count" ? (
            <CountProgress
              value={progress.value}
              total={progress.total}
              percent={percent}
              recovered={recovered}
            />
          ) : (
            <PipelineProgress stages={stageProgress} />
          )}
        </div>

        {/* Event log */}
        <div className="bg-card border rounded-md p-6">
          <div className="font-semibold mb-2">Event log</div>
          <ul className="text-xs font-mono space-y-1 max-h-96 overflow-auto">
            {log.length === 0 && (
              <li className="text-muted-foreground">No events yet.</li>
            )}
            {log.map((entry) => (
              <li
                key={`${entry.ts}-${entry.message}`}
                className={logClass(entry.kind)}
              >
                {new Date(entry.ts).toLocaleTimeString()} — {entry.kind}:{" "}
                {entry.message}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── per-task progress views ───────────────────────────────────────────

function CountProgress({
  value,
  total,
  percent,
  recovered,
}: {
  value: number;
  total: number;
  percent: number;
  recovered: boolean;
}) {
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span>
          Progress: <strong>{value}</strong>
          {total > 0 ? ` / ${total}` : ""}
          {recovered ? " (recovered)" : ""}
        </span>
        <span>{percent}%</span>
      </div>
      <div className="h-2 bg-muted rounded overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function PipelineProgress({
  stages,
}: {
  stages: Record<
    PipelineStage,
    { state: "idle" | "running" | "done"; cached: boolean }
  >;
}) {
  const order: PipelineStage[] = ["extract", "transform", "load"];
  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground">Pipeline stages</div>
      <div className="flex gap-2">
        {order.map((stage) => {
          const s = stages[stage];
          const tone =
            s.state === "done"
              ? s.cached
                ? "bg-amber-100 border-amber-400 text-amber-900"
                : "bg-emerald-100 border-emerald-400 text-emerald-900"
              : s.state === "running"
                ? "bg-blue-100 border-blue-400 text-blue-900 animate-pulse"
                : "bg-muted border-muted-foreground/20 text-muted-foreground";
          return (
            <div
              key={stage}
              className={`flex-1 border rounded-md px-3 py-2 text-sm ${tone}`}
            >
              <div className="font-mono">{stage}</div>
              <div className="text-xs">
                {s.state}
                {s.state === "done" && s.cached ? " (from cache)" : ""}
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-xs text-muted-foreground">
        Recovery hint: simulate a crash mid-pipeline, then nudge — completed
        stages replay from cache (yellow), the in-flight one re-runs.
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────

function makeRunKey(): string {
  return `run-${Math.random().toString(36).slice(2, 10)}`;
}

function logClass(kind: LogEntry["kind"]): string {
  switch (kind) {
    case "error":
      return "text-destructive";
    case "recovered":
      return "text-amber-600";
    case "cached":
      return "text-amber-600";
    case "cancelled":
      return "text-amber-600";
    case "done":
      return "text-emerald-600";
    case "stage":
      return "text-blue-600";
    default:
      return "";
  }
}

/**
 * `executeTask` — durable POST + SSE bridge in one call.
 *
 * Wire shape: each `ctx.emit(name, payload)` becomes
 * `event: <name>` / `data: <JSON.stringify(payload)>`. Bridge-handled:
 * `heartbeat` → SSE comment, `custom:step:*` → dropped (WAL-only),
 * `completed`/`failed`/`cancelled` → forwarded, then loop exits.
 *
 * Identity comes from the active `runInUserContext` scope set by the
 * `asUser(req)` proxy — never from headers or settings.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import type express from "express";
import { getCurrentUserContext } from "../context";
import { createLogger } from "../logging/logger";
import type { ITelemetry } from "../telemetry";
import type { TaskManager } from "./manager";
import {
  RESERVED_BRIDGE_EVENT_NAMES,
  setupSseHeaders,
  writeSseComment,
  writeSseFrame,
} from "./sse";
import type { ActiveBridge } from "./types";

/**
 * Response header carrying the engine-derived idempotency key
 * (`sha256(name || canon(input) || userId)`) so clients can issue
 * follow-up `/resume/:ik` / `/stop/:ik` without rebuilding the input.
 * Mirrored as the first SSE event (`event: ready`) for cross-origin
 * clients that can't read response headers.
 *
 * @public
 */
export const TASK_IDEMPOTENCY_HEADER = "X-AppKit-Task-Idempotency-Key";

const logger = createLogger("tasks:execute");

/** Process-scoped to log the OBO+autoRecover warning once per (plugin, task). @internal */
const oboAutoRecoverWarned = new Set<string>();

export async function executeTask<TInput>(
  deps: {
    manager: TaskManager;
    telemetry: ITelemetry;
    pluginName: string;
  },
  res: express.Response,
  taskName: string,
  input: TInput,
  settings: ExecuteTaskSettings = {},
): Promise<void> {
  const { manager, telemetry, pluginName } = deps;

  // Identity comes only from the active `runInUserContext` scope. A
  // settings-based `userId` override would let any caller forge
  // ownership of `manager.stop()` / `resume()` for another user's IK.
  const userCtx = getCurrentUserContext();
  const userId = userCtx?.userId;
  const isObo = userCtx !== null;

  // OBO + autoRecover is incompatible: the recovery worker has no
  // UserContext, so post-restart OBO calls fail. Warn once per
  // (plugin, task) so a high-traffic misconfigured task doesn't flood.
  if (isObo) {
    const reg = manager.getRegistration(taskName);
    const warningKey = `${pluginName}:${taskName}`;
    if (reg?.autoRecover && !oboAutoRecoverWarned.has(warningKey)) {
      oboAutoRecoverWarned.add(warningKey);
      logger.warn(
        `Plugin "${pluginName}" registered OBO task "${taskName}" with autoRecover=true. ` +
          "After restart, recovery runs without the original UserContext and OBO calls " +
          "will fail. Register with `autoRecover: false` and call `task.resume()` " +
          "from a fresh authenticated request.",
      );
    }
  }

  const wantTraces = settings.telemetry?.traces ?? true;
  // Spans: `tasks.<plugin>.<task>` (parent, submit + subscribe) and
  // `tasks.start` (submit only). Subscribe stays under the parent —
  // a per-event child span would be expensive for no extra signal.
  const tracer = wantTraces ? telemetry.getTracer() : null;
  const span = tracer?.startSpan(`tasks.${pluginName}.${taskName}`, {
    attributes: {
      "task.name": taskName,
      "task.plugin_name": pluginName,
      "task.obo": isObo,
      "task.execute_mode": settings.executeMode ?? "at_least_once",
    },
  });

  let idempotencyKey: string;
  // Hoisted so the outer `finally` can release the bridge regardless
  // of which branch unwinds.
  let unregisterBridge: (() => void) | null = null;
  try {
    // `context` is the live executor sidecar — never serialised, never
    // seen by recovery. Lets the task body re-enter `runInUserContext`
    // without re-parsing headers.
    const startSpan = tracer?.startSpan("tasks.start", {
      attributes: {
        "task.name": taskName,
        "task.execute_mode": settings.executeMode ?? "at_least_once",
      },
    });
    try {
      const handle = await manager.start(taskName, input, {
        userId,
        context: userCtx ?? undefined,
        executeMode: settings.executeMode,
      });
      idempotencyKey = handle.idempotencyKey;
      startSpan?.setAttribute("task.idempotency_key", idempotencyKey);
      startSpan?.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      const message =
        (err as { message?: string } | undefined)?.message ??
        "task start failed";
      startSpan?.setStatus({ code: SpanStatusCode.ERROR, message });
      span?.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      startSpan?.end();
    }

    span?.setAttribute("task.idempotency_key", idempotencyKey);

    const sseRequest = res.req as express.Request | undefined;
    const lastEventId = parseLastEventId(sseRequest);

    if (!res.headersSent) {
      // Dual surface: header for same-origin fetch, `ready` event for
      // cross-origin EventSource (which can't read headers).
      res.setHeader(TASK_IDEMPOTENCY_HEADER, idempotencyKey);
      setupSseHeaders(res);
      writeSseFrame(res, {
        event: "ready",
        data: JSON.stringify({ idempotencyKey }),
      });
    }

    const cancelOnDisconnect = settings.cancelOnDisconnect ?? true;
    const disconnectGraceMs = Math.max(0, settings.disconnectGraceMs ?? 5000);
    let clientClosed = false;
    sseRequest?.once?.("close", () => {
      clientClosed = true;
      if (!cancelOnDisconnect) return;
      // Grace window so a "wifi blipped for 2 s" reconnect doesn't
      // durably suspend the task.
      setTimeout(() => {
        manager
          .stop(idempotencyKey, {
            reason: "client_disconnected",
            userId,
          })
          .catch((err: unknown) => {
            logger.debug(
              `task.stop after client disconnect failed for ${idempotencyKey}: %O`,
              err,
            );
          });
      }, disconnectGraceMs).unref?.();
    });

    // Register so the service can write a final `event: error` frame
    // on shutdown before the engine closes the iterator.
    const bridge: ActiveBridge = {
      idempotencyKey,
      drain: (reason) => {
        clientClosed = true;
        if (res.writableEnded) return;
        try {
          writeSseFrame(res, {
            event: "error",
            data: JSON.stringify({ message: reason }),
          });
        } catch {
          // Response may already be in a bad state.
        }
        if (!res.writableEnded) res.end();
      },
    };
    unregisterBridge = manager._registerBridge(bridge);

    for await (const streamEvent of manager.subscribe(
      idempotencyKey,
      lastEventId,
    )) {
      if (clientClosed || res.writableEnded) break;

      const rawType = streamEvent.event.eventType;

      // Heartbeats are wire-level keep-alives — emit as SSE comment so
      // proxies don't drop idle sockets without leaking to the client.
      if (rawType === "heartbeat") {
        writeSseComment(res, "hb");
        continue;
      }

      // `step:*` checkpoints are WAL-only (consumed by `step()` on
      // recovery). The `step:` prefix is reserved — a plugin emitting
      // `ctx.emit("step:foo", ...)` will be filtered here too.
      if (typeof rawType === "string" && rawType.startsWith("custom:step:")) {
        continue;
      }

      // Engine prefixes user events with `custom:`; strip for the wire.
      const isCustom =
        typeof rawType === "string" && rawType.startsWith("custom:");
      const strippedName = isCustom
        ? rawType.slice("custom:".length)
        : (rawType ?? "message");

      // Reserved-name guard: a plugin emitting `completed` would close
      // the EventSource on the client while the engine keeps publishing.
      // Engine-emitted reserved events (`isCustom === false`) pass.
      if (isCustom && RESERVED_BRIDGE_EVENT_NAMES.has(strippedName)) {
        logger.warn(
          `Plugin "${pluginName}" task "${taskName}" emitted reserved event ` +
            `name "${strippedName}" — refusing to forward.`,
        );
        continue;
      }
      const eventName = strippedName;

      let data: string;
      try {
        // `bigintReplacer`: warehouse `LONG`/`BIGINT` columns surface as
        // JS `BigInt`, which `JSON.stringify` rejects with `TypeError`.
        data = JSON.stringify(streamEvent.event.payload ?? {}, bigintReplacer);
      } catch (err) {
        logger.warn(
          `Failed to serialise event payload for "${taskName}" (event=${rawType}): %O`,
          err,
        );
        data = "{}";
      }

      try {
        // `streamSeq` as SSE `id:` so `Last-Event-ID` reconnects resume
        // from the WAL via `manager.subscribe(ik, lastSeq)`.
        writeSseFrame(res, {
          id: streamEvent.streamSeq,
          event: eventName,
          data,
        });
      } catch (err) {
        logger.debug("SSE write failed; closing stream", err);
        break;
      }

      if (
        rawType === "completed" ||
        rawType === "failed" ||
        rawType === "cancelled"
      ) {
        break;
      }
    }

    if (!res.writableEnded) res.end();
    span?.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span?.setStatus({
      code: SpanStatusCode.ERROR,
      message:
        (err as { message?: string } | undefined)?.message ??
        "executeTask failed",
    });
    if (!res.headersSent) {
      const isProd = process.env.NODE_ENV === "production";
      const message = isProd
        ? "Server error"
        : ((err as { message?: string } | undefined)?.message ??
          "executeTask failed");
      res.status(500).json({ error: message });
    } else if (!res.writableEnded) {
      // In-band SSE error. Redact the message in production so handler
      // exceptions (stacks, paths, secrets) don't reach the wire.
      try {
        const isProd = process.env.NODE_ENV === "production";
        const message = isProd
          ? "Server error"
          : ((err as { message?: string } | undefined)?.message ?? "");
        writeSseFrame(res, {
          event: "error",
          data: JSON.stringify({ message }),
        });
      } catch {
        // Ignore.
      }
      res.end();
    }
    logger.error(
      `executeTask("${taskName}") failed for plugin "${pluginName}": %O`,
      err,
    );
    throw err;
  } finally {
    unregisterBridge?.();
    span?.end();
  }
}

function parseLastEventId(
  req: express.Request | undefined,
): number | undefined {
  const raw = req?.header?.("last-event-id") ?? req?.header?.("Last-Event-ID");
  if (!raw) return undefined;
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return undefined;
  // Clamp: negative values rewind past the WAL retention prefix
  // (used to infinite-loop on subscribe), and engine seq comparisons
  // lose precision past 2^53. Engine still validates against its own
  // retention window — this just stops the obvious abuse at the FFI.
  if (parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) return undefined;
  return parsed;
}

/** Serialises `BigInt` as string. Warehouse `LONG`/`BIGINT` columns. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Settings for `Plugin.executeTask`. Deliberately disjoint from
 * `PluginExecutionSettings`: the task engine handles retry / dedup /
 * timeout natively, so those knobs are typed `never` to fail at
 * compile time.
 *
 * @example
 * ```ts
 * await this.executeTask(res, "agent-loop", req.body, {
 *   cancelOnDisconnect: false, // long-running OBO tasks survive reconnect
 * });
 * ```
 *
 * @public
 */
export interface ExecuteTaskSettings {
  /**
   * Issue cooperative `task.stop()` when the SSE client disconnects.
   * Default `true`. Set `false` for OBO tasks the user reconnects to
   * (engine keeps writing the WAL; reconnects replay via `Last-Event-ID`).
   *
   * Note: OBO tokens expire in 1 hour. For longer runs, register with
   * `autoRecover: false` and resume from a fresh authenticated request.
   */
  cancelOnDisconnect?: boolean;
  /**
   * Grace window before `task.stop()` after client close. Default
   * `5000`. Bridges the "wifi blipped for 2 s" reconnect case. Set `0`
   * for cancel-immediately.
   */
  disconnectGraceMs?: number;
  /**
   * Idempotency strictness for `engine.submit`.
   *
   * - `at_least_once` (default): cache-backed dedup, fast path. Two
   *   pods may both submit within the cache window — fine for
   *   idempotent reads.
   * - `at_most_once`: queries storage before creating the task, so
   *   cross-pod uniqueness holds. Use for non-idempotent side effects
   *   (DML, external writes, billing). Costs single-digit ms on submit.
   *
   * Cross-pod uniqueness requires a shared storage backend
   * (`storage.backend: "lakebase"`) — default per-pod SQLite cannot
   * coordinate.
   */
  executeMode?: "at_least_once" | "at_most_once";
  telemetry?: {
    /** Default: true. */
    traces?: boolean;
    /** Default: true. */
    metrics?: boolean;
  };

  // Typed `never`: rejected at compile time so a settings object copied
  // from `execute()` / `executeStream()` errors clearly.

  /** Forbidden: the task engine handles retry via `recover` on `TaskDefinition`. */
  retry?: never;
  /** Forbidden: the task engine dedupes by idempotency key. */
  cache?: never;
  /** Forbidden: the task engine uses cooperative `stop()` + `staleThresholdMs`. */
  timeout?: never;
  /** Forbidden: wire shape is fixed by what the handler emits. */
  stream?: never;
  /**
   * Forbidden: identity comes from the active `runInUserContext` scope
   * (`asUser(req)` proxy). Accepting a raw `userId` would let callers
   * forge ownership for `stop()` / `resume()`.
   */
  userId?: never;
}

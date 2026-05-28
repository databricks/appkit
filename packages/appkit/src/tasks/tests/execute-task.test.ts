/**
 * Tests for the durable `executeTask` SSE bridge.
 *
 * Most behaviour of the bridge is covered indirectly by the analytics
 * plugin's integration tests (wire-shape, recovery, terminal events).
 * The cases below isolate the production-hardening primitives that
 * have no other test coverage:
 *
 *  - the wall-clock idle keep-alive that fires when the engine stream
 *    is genuinely silent for `IDLE_KEEPALIVE_INTERVAL_MS` ms.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStubTaskManager } from "../../../../../tools/test-helpers";
import { executeTask, IDLE_KEEPALIVE_INTERVAL_MS } from "../execute-task";
import type { TaskManager } from "../index";

type SsePiece = string;

/**
 * Minimal `express.Response` stand-in: captures every chunk written so
 * the test can assert SSE framing without spinning up a real server.
 */
function createMockResponse() {
  const chunks: SsePiece[] = [];
  let writableEnded = false;
  let headersSent = false;
  const headers: Record<string, string> = {};

  const req = {
    once: vi.fn(),
    header: vi.fn(() => undefined),
  };

  const res = {
    req,
    get statusCode() {
      return 200;
    },
    set statusCode(_v: number) {},
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    setHeader: vi.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    flushHeaders: vi.fn(() => {
      headersSent = true;
    }),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      writableEnded = true;
    }),
    status: vi.fn(function status(this: unknown, _code: number) {
      return res;
    }),
    json: vi.fn(),
  } as unknown as import("express").Response;

  return { res, chunks, headers, req };
}

/**
 * Minimal `ITelemetry` stand-in: returns no tracer, so the bridge skips
 * span work entirely. We just need the surface area for `deps`.
 */
function createNoopTelemetry() {
  return {
    getTracer: () => null,
    getMeter: () => null,
    getLogger: () => null,
  } as unknown as import("../../telemetry").ITelemetry;
}

describe("executeTask idle keep-alive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("writes an SSE comment after IDLE_KEEPALIVE_INTERVAL_MS while engine is silent", async () => {
    const stub = createStubTaskManager();
    const managerAsType = stub as unknown as TaskManager;
    const { res, chunks } = createMockResponse();

    // Handler awaits a deferred we hold open so the engine stream
    // stays silent past the keep-alive window. The fake-timer clock
    // can advance past the wall-clock interval without `def.execute`
    // ever resolving, which is exactly the production-hostile shape
    // (long downstream call + idle proxy) the keep-alive exists for.
    let releaseHandler!: () => void;
    const handlerDone = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    stub.task({
      name: "silent-task",
      execute: async () => {
        await handlerDone;
        return { ok: true };
      },
    });

    const bridge = executeTask(
      {
        manager: managerAsType,
        telemetry: createNoopTelemetry(),
        pluginName: "test",
      },
      res,
      "silent-task",
      { x: 1 },
      { telemetry: { traces: false } },
    );

    // Flush microtasks so `manager.start` resolves and the keep-alive
    // interval is installed before we advance time.
    await vi.advanceTimersByTimeAsync(0);

    // No keep-alive yet: we haven't reached the interval boundary.
    expect(chunks.some((c) => c.startsWith(": hb"))).toBe(false);

    // Wall-clock keep-alive should fire once per interval window.
    await vi.advanceTimersByTimeAsync(IDLE_KEEPALIVE_INTERVAL_MS);
    const afterFirstFire = chunks.filter((c) => c.startsWith(": hb")).length;
    expect(afterFirstFire).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(IDLE_KEEPALIVE_INTERVAL_MS);
    const afterSecondFire = chunks.filter((c) => c.startsWith(": hb")).length;
    expect(afterSecondFire).toBeGreaterThan(afterFirstFire);

    // Release the handler so the bridge can finish cleanly and the
    // outer `finally` clears the interval.
    releaseHandler();
    await bridge;
  });

  test("clears the keep-alive interval when the bridge exits", async () => {
    const stub = createStubTaskManager();
    const managerAsType = stub as unknown as TaskManager;
    const { res, chunks } = createMockResponse();
    stub.task({
      name: "fast-task",
      execute: async () => ({ ok: true }),
    });

    await executeTask(
      {
        manager: managerAsType,
        telemetry: createNoopTelemetry(),
        pluginName: "test",
      },
      res,
      "fast-task",
      {},
      { telemetry: { traces: false } },
    );

    // After the bridge exits, the keep-alive must not continue to
    // fire — advancing a full interval should add no new `: hb`
    // frames.
    const baseline = chunks.filter((c) => c.startsWith(": hb")).length;
    await vi.advanceTimersByTimeAsync(IDLE_KEEPALIVE_INTERVAL_MS * 2);
    const after = chunks.filter((c) => c.startsWith(": hb")).length;
    expect(after).toBe(baseline);
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMockTelemetry } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SidecarError } from "../../../errors/sidecar";

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { StdioBridge } from "../stdio-bridge";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout };
}

function createExtendedMockTelemetry() {
  const base = createMockTelemetry();
  // Extend meter mock with createUpDownCounter (not in shared test-helpers)
  const meter = base.getMeter();
  (meter as any).createUpDownCounter = vi.fn().mockReturnValue({ add: vi.fn() });
  return base;
}

function createBridge(configOverrides = {}, telemetry?: any) {
  const t = telemetry ?? createExtendedMockTelemetry();
  const bridge = new StdioBridge(configOverrides, t);
  return { bridge, telemetry: t };
}

function sendJsonRpcResponse(stdout: PassThrough, msg: Record<string, unknown>) {
  stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendNotification(stdout: PassThrough, method: string, params?: unknown) {
  sendJsonRpcResponse(stdout, { jsonrpc: "2.0", method, params });
}

function sendResponse(stdout: PassThrough, id: number, result: unknown) {
  sendJsonRpcResponse(stdout, { jsonrpc: "2.0", id, result });
}

function sendErrorResponse(
  stdout: PassThrough,
  id: number,
  code: number,
  message: string,
) {
  sendJsonRpcResponse(stdout, {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("StdioBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("D. JSON-RPC Bridge", () => {
    test("D1: simple request → response with id correlation", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const requestPromise = bridge.sendRequest({ path: "/test" });

      // Read what was written to stdin
      const written = stdin.read()?.toString();
      const parsed = JSON.parse(written!);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("request");
      expect(parsed.params.path).toBe("/test");

      // Send back response with matching id
      sendResponse(stdout, parsed.id, { status: 200, body: { ok: true } });

      const result = await requestPromise;
      expect(result).toEqual({ status: 200, body: { ok: true } });
    });

    test("D2: multiple concurrent requests resolved by id matching", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const p1 = bridge.sendRequest({ path: "/first" });
      const p2 = bridge.sendRequest({ path: "/second" });

      // Read both requests
      const buf = stdin.read()?.toString() ?? "";
      const lines = buf.split("\n").filter(Boolean);
      const req1 = JSON.parse(lines[0]);
      const req2 = JSON.parse(lines[1]);

      // Respond in reverse order
      sendResponse(stdout, req2.id, { status: 200, body: "second" });
      sendResponse(stdout, req1.id, { status: 200, body: "first" });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.body).toBe("first");
      expect(r2.body).toBe("second");
    });

    test("D3: request timeout returns bridgeTimeout error", async () => {
      const { bridge } = createBridge({ requestTimeout: 100 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const requestPromise = bridge.sendRequest({ path: "/slow" });

      // Catch the rejection immediately to prevent unhandled rejection
      const resultPromise = requestPromise.catch((err) => err);

      await vi.advanceTimersByTimeAsync(150);

      const err = await resultPromise;
      expect(err).toBeInstanceOf(SidecarError);
      expect(err.message).toMatch(/timed out/);
    });

    test("D4: max concurrency exceeded returns 503", async () => {
      const { bridge } = createBridge({
        requestTimeout: 5000,
        maxConcurrency: 2,
      });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      // Fill up concurrency
      bridge.sendRequest({ path: "/1" });
      bridge.sendRequest({ path: "/2" });

      // Third should fail
      await expect(bridge.sendRequest({ path: "/3" })).rejects.toThrow(
        /concurrency limit/,
      );
    });

    test("D5: JSON-RPC error with code < -32000 is not retryable", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const p = bridge.sendRequest({ path: "/err" });

      const written = stdin.read()?.toString();
      const req = JSON.parse(written!);
      sendErrorResponse(stdout, req.id, -32001, "Parse error");

      try {
        await p;
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SidecarError);
        expect((err as SidecarError).isRetryable).toBe(false);
      }
    });

    test("D6: JSON-RPC error with code >= -32000 is retryable", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const p = bridge.sendRequest({ path: "/err" });

      const written = stdin.read()?.toString();
      const req = JSON.parse(written!);
      sendErrorResponse(stdout, req.id, -31999, "Temporary error");

      try {
        await p;
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SidecarError);
        expect((err as SidecarError).isRetryable).toBe(true);
      }
    });

    test("D7: notification without id calls onNotification callback", async () => {
      const onNotification = vi.fn();
      const { bridge } = createBridge({
        requestTimeout: 5000,
        onNotification,
      });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      sendNotification(stdout, "custom-event", { data: "hello" });

      // Allow event processing
      await vi.advanceTimersByTimeAsync(0);

      expect(onNotification).toHaveBeenCalledWith("custom-event", { data: "hello" });
    });

    test("D7: 'ready' notification sets ready state", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const readyPromise = bridge.waitForReady(5000);

      sendNotification(stdout, "ready");

      const result = await readyPromise;
      expect(result).toBe(true);
    });

    test("D8: partial line buffering works correctly", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const p = bridge.sendRequest({ path: "/test" });
      const written = stdin.read()?.toString();
      const req = JSON.parse(written!);

      // Send response in two chunks (partial line)
      const fullResponse = JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { status: 200, body: "ok" },
      });

      const mid = Math.floor(fullResponse.length / 2);
      stdout.write(fullResponse.substring(0, mid));
      stdout.write(`${fullResponse.substring(mid)}\n`);

      const result = await p;
      expect(result.body).toBe("ok");
    });

    test("D9: invalid JSON from child is handled gracefully", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      // Send invalid JSON — should not crash
      stdout.write("this is not valid json\n");
      await vi.advanceTimersByTimeAsync(0);

      // Bridge should still work after invalid JSON
      const p = bridge.sendRequest({ path: "/test" });
      const written = stdin.read()?.toString();
      const lines = written!.split("\n").filter(Boolean);
      const req = JSON.parse(lines[lines.length - 1]);

      sendResponse(stdout, req.id, { status: 200, body: "still working" });

      const result = await p;
      expect(result.body).toBe("still working");
    });

    test("D10: stdin write fails when child died", () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      // Simulate destroyed stdin
      stdin.destroy();

      expect(() => bridge.sendRequest({ path: "/dead" })).rejects.toThrow(
        /stdin/,
      );
    });

    test("D10: stdin write fails when not attached", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });

      await expect(bridge.sendRequest({ path: "/no-stdin" })).rejects.toThrow(
        /stdin/,
      );
    });

    test("D11: ping succeeds when child responds", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const pingPromise = bridge.ping(1000);

      // Read ping request
      await vi.advanceTimersByTimeAsync(0);
      const written = stdin.read()?.toString();
      const req = JSON.parse(written!);
      expect(req.method).toBe("ping");

      sendResponse(stdout, req.id, {});

      const result = await pingPromise;
      expect(result).toBe(true);
    });

    test("D12: ping failures trigger unhealthy callback", async () => {
      const { bridge } = createBridge({
        requestTimeout: 100,
        pingInterval: 100,
        pingFailureThreshold: 2,
      });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const onHealthy = vi.fn();
      const onUnhealthy = vi.fn();

      bridge.startHealthCheck({ onHealthy, onUnhealthy });

      // Let pings time out
      await vi.advanceTimersByTimeAsync(100); // first check
      await vi.advanceTimersByTimeAsync(150); // ping timeout
      await vi.advanceTimersByTimeAsync(100); // second check
      await vi.advanceTimersByTimeAsync(150); // ping timeout

      expect(onUnhealthy).toHaveBeenCalled();

      bridge.stopHealthCheck();
    });
  });

  describe("waitForReady", () => {
    test("returns true immediately if already ready", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      // Make ready via notification
      sendNotification(stdout, "ready");
      await vi.advanceTimersByTimeAsync(0);

      const result = await bridge.waitForReady(1000);
      expect(result).toBe(true);
    });

    test("returns false on timeout", async () => {
      const { bridge } = createBridge({ requestTimeout: 100 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const readyPromise = bridge.waitForReady(200);

      await vi.advanceTimersByTimeAsync(300);

      const result = await readyPromise;
      expect(result).toBe(false);
    });
  });

  describe("attach / detach", () => {
    test("detach clears state and stops listening", () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);
      bridge.detach();

      // After detach, sending data should not cause errors
      stdout.write('{"jsonrpc":"2.0","method":"ready"}\n');
      // No crash = pass
    });
  });

  describe("destroy", () => {
    test("rejects all pending requests", async () => {
      const { bridge } = createBridge({ requestTimeout: 30000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const p1 = bridge.sendRequest({ path: "/1" });
      const p2 = bridge.sendRequest({ path: "/2" });

      bridge.destroy();

      await expect(p1).rejects.toThrow(/destroyed/);
      await expect(p2).rejects.toThrow(/destroyed/);
    });

    test("stops health check interval", () => {
      const { bridge } = createBridge({
        requestTimeout: 5000,
        pingInterval: 100,
      });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      bridge.startHealthCheck({ onHealthy: vi.fn(), onUnhealthy: vi.fn() });
      bridge.destroy();

      // Should not throw after destroy
    });
  });

  describe("non-JSON-RPC messages", () => {
    test("ignores messages without jsonrpc: 2.0", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      stdout.write(`${JSON.stringify({ foo: "bar" })}\n`);
      await vi.advanceTimersByTimeAsync(0);

      // No crash, bridge still operational
    });

    test("response for unknown id is silently ignored", async () => {
      const { bridge } = createBridge({ requestTimeout: 5000 });
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      sendResponse(stdout, 99999, { status: 200 });
      await vi.advanceTimersByTimeAsync(0);

      // No crash = pass
    });
  });

  describe("H. Telemetry", () => {
    test("H2: sendRequest creates span", async () => {
      const telemetry = createExtendedMockTelemetry();
      const { bridge } = createBridge({ requestTimeout: 5000 }, telemetry);
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      const p = bridge.sendRequest({ path: "/traced" });

      const written = stdin.read()?.toString();
      const req = JSON.parse(written!);
      sendResponse(stdout, req.id, { status: 200 });

      await p;

      expect(telemetry.startActiveSpan).toHaveBeenCalledWith(
        "sidecar.stdio.request",
        expect.objectContaining({
          attributes: expect.objectContaining({
            "sidecar.stdio.path": "/traced",
          }),
        }),
        expect.any(Function),
      );
    });

    test("H3: waitForReady creates startup span", async () => {
      const telemetry = createExtendedMockTelemetry();
      const { bridge } = createBridge({ requestTimeout: 5000 }, telemetry);
      const { stdin, stdout } = createStreams();
      bridge.attach(stdin, stdout);

      // Start waiting first, THEN send ready notification
      const readyPromise = bridge.waitForReady(5000);
      sendNotification(stdout, "ready");
      await readyPromise;

      expect(telemetry.startActiveSpan).toHaveBeenCalledWith(
        "sidecar.stdio.startup",
        expect.objectContaining({
          attributes: expect.objectContaining({
            "sidecar.stdio.timeout": 5000,
          }),
        }),
        expect.any(Function),
      );
    });
  });
});

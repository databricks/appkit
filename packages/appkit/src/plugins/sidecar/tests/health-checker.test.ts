import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { HealthChecker } from "../health-checker";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HealthChecker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ──────────────── E. Health Checking ────────────────

  describe("E. Health Checking", () => {
    test("E1: responds 200 on /health → status healthy", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(3000);
      const onHealthy = vi.fn();
      const onUnhealthy = vi.fn();

      checker.start({ onHealthy, onUnhealthy });

      await vi.advanceTimersByTimeAsync(5000);

      expect(onHealthy).toHaveBeenCalled();
      expect(onUnhealthy).not.toHaveBeenCalled();

      checker.stop();
    });

    test("E2: custom healthCheck.path is used", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(3000, { path: "/ready" });

      checker.start({ onHealthy: vi.fn(), onUnhealthy: vi.fn() });

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/ready",
        expect.anything(),
      );

      checker.stop();
    });

    test("E3: health check timeout counts as failure", async () => {
      mockFetch.mockRejectedValue(new Error("timeout"));
      const checker = new HealthChecker(3000, {
        timeout: 1000,
        unhealthyThreshold: 1,
      });
      const onUnhealthy = vi.fn();

      checker.start({ onHealthy: vi.fn(), onUnhealthy });

      await vi.advanceTimersByTimeAsync(5000);

      expect(onUnhealthy).toHaveBeenCalled();

      checker.stop();
    });

    test("E4: consecutive failures exceed threshold → unhealthy", async () => {
      mockFetch.mockResolvedValue({ ok: false });
      const checker = new HealthChecker(3000, {
        interval: 100,
        unhealthyThreshold: 3,
      });
      const onUnhealthy = vi.fn();

      checker.start({ onHealthy: vi.fn(), onUnhealthy });

      // 3 checks at 100ms intervals
      await vi.advanceTimersByTimeAsync(350);

      expect(onUnhealthy).toHaveBeenCalled();

      checker.stop();
    });

    test("E5: recovery after transient failure resets counter", async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        // Fail first 2, then succeed
        if (callCount <= 2) return Promise.resolve({ ok: false });
        return Promise.resolve({ ok: true });
      });

      const checker = new HealthChecker(3000, {
        interval: 100,
        unhealthyThreshold: 3,
      });
      const onHealthy = vi.fn();
      const onUnhealthy = vi.fn();

      checker.start({ onHealthy, onUnhealthy });

      // 2 failures + 1 success = should NOT trigger unhealthy
      await vi.advanceTimersByTimeAsync(350);

      expect(onUnhealthy).not.toHaveBeenCalled();
      expect(onHealthy).toHaveBeenCalled();

      checker.stop();
    });

    test("E6: health check interval is respected", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(3000, { interval: 2000 });

      checker.start({ onHealthy: vi.fn(), onUnhealthy: vi.fn() });

      // At 1500ms, only 0 checks should have fired (first fires at 2000ms)
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockFetch).toHaveBeenCalledTimes(0);

      // At 2500ms, 1 check should have fired
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      checker.stop();
    });
  });

  describe("waitForReady", () => {
    test("returns true when health check passes", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(3000);

      const readyPromise = checker.waitForReady(5000);

      await vi.advanceTimersByTimeAsync(1500);

      const result = await readyPromise;
      expect(result).toBe(true);
    });

    test("returns false when timeout exceeded", async () => {
      mockFetch.mockRejectedValue(new Error("connection refused"));
      const checker = new HealthChecker(3000, { timeout: 100 });

      const readyPromise = checker.waitForReady(500);

      // Advance past the timeout, allowing each poll cycle to complete
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      const result = await readyPromise;
      expect(result).toBe(false);
    });

    test("returns false when aborted via signal", async () => {
      mockFetch.mockResolvedValue({ ok: false });
      const controller = new AbortController();
      const checker = new HealthChecker(3000);

      const readyPromise = checker.waitForReady(10000, controller.signal);

      controller.abort();
      await vi.advanceTimersByTimeAsync(1500);

      const result = await readyPromise;
      expect(result).toBe(false);
    });
  });

  describe("stop", () => {
    test("clears interval", () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(3000);

      checker.start({ onHealthy: vi.fn(), onUnhealthy: vi.fn() });
      checker.stop();

      // No further checks after stop
      mockFetch.mockClear();
      vi.advanceTimersByTime(10000);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("start after stop restarts the interval", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(3000, { interval: 100 });

      checker.start({ onHealthy: vi.fn(), onUnhealthy: vi.fn() });
      checker.stop();

      const onHealthy = vi.fn();
      checker.start({ onHealthy, onUnhealthy: vi.fn() });

      await vi.advanceTimersByTimeAsync(150);

      expect(onHealthy).toHaveBeenCalled();

      checker.stop();
    });
  });

  describe("defaults", () => {
    test("uses /health path by default", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(8080);

      checker.start({ onHealthy: vi.fn(), onUnhealthy: vi.fn() });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/health",
        expect.anything(),
      );

      checker.stop();
    });

    test("uses AbortSignal.timeout for request timeout", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const checker = new HealthChecker(3000, { timeout: 2000 });

      checker.start({ onHealthy: vi.fn(), onUnhealthy: vi.fn() });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      checker.stop();
    });
  });
});

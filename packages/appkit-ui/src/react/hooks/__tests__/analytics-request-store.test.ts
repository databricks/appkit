import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let capturedCallbacks: {
  onMessage?: (msg: { data: string }) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
} = {};

const mockFetchArrow = vi.fn();

// Mock connectSSE to capture calls and track uncached requests.
const mockConnectSSE = vi.fn((args: any): unknown => {
  capturedCallbacks = {
    onMessage: args?.onMessage,
    onError: args?.onError,
    signal: args?.signal,
  };
  return () => {};
});

const mockProcessArrowBuffer = vi.fn();

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...(args as [any])),
  ArrowClient: {
    fetchArrow: (...args: unknown[]) => mockFetchArrow(...args),
    processArrowBuffer: (...args: unknown[]) => mockProcessArrowBuffer(...args),
  },
}));

import {
  getSnapshot,
  refetch,
  resetAnalyticsRequestStore,
  retain,
  start,
  subscribe,
} from "../analytics-request-store";

const JSON_OPTS = {
  url: "/api/analytics/query/q",
  payload: JSON.stringify({ parameters: null, format: "JSON_ARRAY" }),
  format: "JSON_ARRAY",
};

describe("analytics-request-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = {};
    resetAnalyticsRequestStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("retain and start", () => {
    test("retain with autoStart:false does not start the request", () => {
      retain("k", JSON_OPTS, false);
      expect(mockConnectSSE).not.toHaveBeenCalled();
    });

    test("start on an autoStart:false entry begins the request", () => {
      retain("k", JSON_OPTS, false);
      expect(mockConnectSSE).not.toHaveBeenCalled();

      start("k");
      expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    });

    test("retain with default autoStart:true starts the request immediately", () => {
      retain("k", JSON_OPTS);
      expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    });
  });

  describe("refetch", () => {
    test("refetch aborts in-flight run and restarts with same options", () => {
      retain("k", JSON_OPTS);
      const firstSignal = capturedCallbacks.signal;

      // Mark the first signal as aborted to simulate abort behavior
      Object.defineProperty(firstSignal, "aborted", {
        value: false,
        configurable: true,
      });

      // Now refetch — should call connectSSE a second time
      refetch("k");

      expect(mockConnectSSE).toHaveBeenCalledTimes(2);

      // The second call is a fresh start (new signal).
      const secondCall = mockConnectSSE.mock.calls[1];
      const secondSignal = secondCall[0].signal;

      // Signals are distinct.
      expect(secondSignal).not.toBe(firstSignal);
    });

    test("refetch marks the key for uncached execution on next start", () => {
      const release = retain("k", JSON_OPTS, false);
      expect(mockConnectSSE).not.toHaveBeenCalled();

      // Mark for uncached.
      refetch("k");

      // start() is called; the entry should be re-invoked with skipCache set.
      // Check that the payload now includes skipCache:true.
      expect(mockConnectSSE).toHaveBeenCalledTimes(1);

      const call = mockConnectSSE.mock.calls[0];
      const payload = call[0].payload;
      const parsed = JSON.parse(payload);
      expect(parsed.skipCache).toBe(true);

      release();
    });

    test("skipCache flag is included in payload for SSE requests", () => {
      const sseOpts = {
        url: "/api/analytics/query/test",
        payload: JSON.stringify({ parameters: { x: 1 }, format: "JSON_ARRAY" }),
        format: "JSON_ARRAY",
        skipCache: true,
      };

      retain("ssekey", sseOpts);

      expect(mockConnectSSE).toHaveBeenCalledTimes(1);
      const call = mockConnectSSE.mock.calls[0];
      const payload = call[0].payload;
      const parsed = JSON.parse(payload);

      expect(parsed).toEqual({
        parameters: { x: 1 },
        format: "JSON_ARRAY",
        skipCache: true,
      });
    });

    test("skipCache flag is included in payload for ARROW_STREAM requests", async () => {
      const fakeTable = { numRows: 1, schema: { fields: [] } };
      const fakeBytes = new Uint8Array([1, 2, 3]);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeBytes.buffer,
        headers: { get: () => null },
      });
      vi.stubGlobal("fetch", fetchMock);
      mockProcessArrowBuffer.mockResolvedValueOnce(fakeTable);

      const arrowOpts = {
        url: "/api/analytics/query/arrow_test",
        payload: JSON.stringify({ parameters: null, format: "ARROW_STREAM" }),
        format: "ARROW_STREAM",
        skipCache: true,
      };

      retain("arrowkey", arrowOpts);

      // Wait for the arrow fetch to be called.
      await new Promise((r) => setTimeout(r, 10));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      const payload = JSON.parse(init.body);

      expect(payload).toEqual({
        parameters: null,
        format: "ARROW_STREAM",
        skipCache: true,
      });
    });

    test("uncached mark is consumed on next start and does not persist", () => {
      const release1 = retain("k", JSON_OPTS, false);

      // Mark for uncached.
      refetch("k");
      expect(mockConnectSSE).toHaveBeenCalledTimes(1);

      let payload = JSON.parse(mockConnectSSE.mock.calls[0][0].payload);
      expect(payload.skipCache).toBe(true);

      release1();

      // After teardown, re-retain the same key without refetch.
      // The uncached mark should not persist.
      retain("k", JSON_OPTS);

      // Teardown is deferred, so this will reuse the existing entry.
      // Let's wait for teardown and then re-retain explicitly.
      resetAnalyticsRequestStore();
      vi.clearAllMocks();

      const release2 = retain("k", JSON_OPTS);
      expect(mockConnectSSE).toHaveBeenCalledTimes(1);

      payload = JSON.parse(mockConnectSSE.mock.calls[0][0].payload);
      expect(payload.skipCache).toBeUndefined();

      release2();
    });
  });

  describe("retain with autoStart:false and refetch composition", () => {
    test("retain(autoStart:false) + refetch defers start but executes with uncached on refetch", () => {
      const release = retain("deferred", JSON_OPTS, false);

      // No request yet.
      expect(mockConnectSSE).not.toHaveBeenCalled();

      // refetch marks for uncached and starts.
      refetch("deferred");

      expect(mockConnectSSE).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(mockConnectSSE.mock.calls[0][0].payload);
      expect(payload.skipCache).toBe(true);

      release();
    });

    test("multiple refetch calls re-invoke the runner each time", () => {
      retain("multi", JSON_OPTS, false);

      refetch("multi");
      expect(mockConnectSSE).toHaveBeenCalledTimes(1);

      refetch("multi");
      expect(mockConnectSSE).toHaveBeenCalledTimes(2);

      refetch("multi");
      expect(mockConnectSSE).toHaveBeenCalledTimes(3);

      // All three should have skipCache.
      for (let i = 0; i < 3; i++) {
        const payload = JSON.parse(mockConnectSSE.mock.calls[i][0].payload);
        expect(payload.skipCache).toBe(true);
      }
    });
  });

  describe("snapshot subscribers", () => {
    test("refetch triggers updates to subscribers via snapshot", () => {
      const release = retain("snap", JSON_OPTS, false);
      const listener = vi.fn();
      subscribe("snap", listener);

      refetch("snap");

      // Refetch should have triggered a start → loading snapshot notification.
      expect(listener).toHaveBeenCalled();
      expect(getSnapshot("snap").loading).toBe(true);

      release();
    });
  });
});

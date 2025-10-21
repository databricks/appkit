import { beforeEach, describe, expect, test, vi } from "vitest";
import { StreamManager } from "../src/index";

function createMockResponse(headers: Record<string, string> = {}) {
  const events: string[] = [];
  const mockRes = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((data: string) => {
      events.push(data);
    }),
    end: vi.fn(),
    on: vi.fn(),
    writableEnded: false,
    req: {
      headers: headers,
    },
  };
  return { mockRes, events };
}

describe("StreamManager", () => {
  let streamManager: StreamManager;

  beforeEach(() => {
    streamManager = new StreamManager();
    vi.clearAllMocks();
  });

  describe("basic streaming", () => {
    test("should stream multiple events in order", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "start", message: "Starting" };
        yield { type: "progress", message: "Step 1" };
        yield { type: "progress", message: "Step 2" };
        yield { type: "progress", message: "Step 3" };
        yield { type: "progress", message: "Step 4" };
        yield { type: "complete", message: "Finished" };
      }

      await streamManager.stream(mockRes as any, generator);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(events).toContain(
        'data: {"type":"start","message":"Starting"}\n\n',
      );
      expect(events).toContain(
        'data: {"type":"progress","message":"Step 1"}\n\n',
      );
      expect(events).toContain(
        'data: {"type":"progress","message":"Step 2"}\n\n',
      );
      expect(events).toContain(
        'data: {"type":"progress","message":"Step 3"}\n\n',
      );
      expect(events).toContain(
        'data: {"type":"progress","message":"Step 4"}\n\n',
      );
      expect(events).toContain(
        'data: {"type":"complete","message":"Finished"}\n\n',
      );

      const startIndex = events.findIndex((e) => e.includes("Starting"));
      const step1Index = events.findIndex((e) => e.includes("Step 1"));
      const step2Index = events.findIndex((e) => e.includes("Step 2"));
      const step3Index = events.findIndex((e) => e.includes("Step 3"));
      const step4Index = events.findIndex((e) => e.includes("Step 4"));
      const finishedIndex = events.findIndex((e) => e.includes("Finished"));

      expect(startIndex).toBeLessThan(step1Index);
      expect(step1Index).toBeLessThan(step2Index);
      expect(step2Index).toBeLessThan(step3Index);
      expect(step3Index).toBeLessThan(step4Index);
      expect(step4Index).toBeLessThan(finishedIndex);

      expect(mockRes.end).toHaveBeenCalled();
      expect(streamManager.getActiveCount()).toBe(0);
    });

    test("should use default message type when not provided", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { data: "test" };
      }

      await streamManager.stream(mockRes as any, generator);

      expect(events).toContain("event: message\n");
      expect(events).toContain('data: {"data":"test"}\n\n');
    });

    test("should sanitize event types to prevent sse injection", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: 'test\ndata: {"injected":true}', message: "test" };
      }

      await streamManager.stream(mockRes as any, generator);

      const eventLine = events.find((e) => e.startsWith("event: "));
      expect(eventLine).toBe('event: testdata: {"injected":true}\n');

      const dataLines = events.filter((e) => e.startsWith("data: "));
      expect(dataLines.length).toBe(1);
    });

    test("should limit event type length to 100 chars", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "a".repeat(200), message: "test" };
      }

      await streamManager.stream(mockRes as any, generator);

      const eventLine = events.find((e) => e.startsWith("event: "));
      const eventType = eventLine?.replace("event: ", "").replace("\n", "");
      expect(eventType?.length).toBeLessThanOrEqual(100);
    });
  });

  describe("abort and cancellation", () => {
    test("should stop streaming when user signal is aborted", async () => {
      const { mockRes, events } = createMockResponse();
      const abortController = new AbortController();

      async function* generator(signal: AbortSignal) {
        yield { type: "start" };
        abortController.abort();
        if (!signal.aborted) {
          yield { type: "end", message: "Should not appear" };
        }
      }

      await streamManager.stream(mockRes as any, generator, {
        userSignal: abortController.signal,
      });

      expect(events).toContain('data: {"type":"start"}\n\n');
      expect(events).not.toContain("Should not appear");
    });

    test("should abort all active streams", async () => {
      const { mockRes: mockRes1 } = createMockResponse();
      const { mockRes: mockRes2 } = createMockResponse();

      async function* generator(signal: AbortSignal) {
        let count = 0;
        while (!signal.aborted && count < 100) {
          yield { type: "progress", count: count++ };
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      const stream1 = streamManager.stream(mockRes1 as any, generator);
      const stream2 = streamManager.stream(mockRes2 as any, generator);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(streamManager.getActiveCount()).toBe(2);

      streamManager.abortAll();
      await Promise.all([stream1, stream2]);

      expect(streamManager.getActiveCount()).toBe(0);
    });

    test("should track client disconnect", async () => {
      const { mockRes } = createMockResponse();
      let closeHandler: (() => void) | undefined;

      mockRes.on.mockImplementation((event: string, handler: () => void) => {
        if (event === "close") {
          closeHandler = handler;
        }
      });

      async function* generator() {
        yield { type: "test" };
      }

      const streamPromise = streamManager.stream(mockRes as any, generator);
      expect(streamManager.getActiveCount()).toBe(1);

      if (closeHandler) closeHandler();
      await streamPromise;

      expect(streamManager.getActiveCount()).toBe(0);
    });
  });

  describe("error handling", () => {
    test("should send error event when handler throws", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "start" };
        throw new Error("Test error");
      }

      await streamManager.stream(mockRes as any, generator);

      expect(events).toContain('data: {"type":"start"}\n\n');
      expect(events).toContain("event: error\n");
      expect(events).toContain('data: {"error":"Test error"}\n\n');
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should handle non-error exceptions", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "start" };
        throw "String error";
      }

      await streamManager.stream(mockRes as any, generator);

      expect(events).toContain("event: error\n");
      expect(events).toContain('data: {"error":"Internal server error"}\n\n');
    });

    test("should not crash if client disconnects during error", async () => {
      const { mockRes } = createMockResponse();

      async function* generator() {
        yield { type: "start" };
        mockRes.writableEnded = true;
        throw new Error("Test error");
      }

      await expect(
        streamManager.stream(mockRes as any, generator),
      ).resolves.not.toThrow();
    });

    test("should handle circular reference in error", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "start" };
        const circularError: any = new Error("Circular error");
        circularError.self = circularError;
        throw circularError;
      }

      await expect(
        streamManager.stream(mockRes as any, generator),
      ).resolves.not.toThrow();

      expect(events.some((e) => e.includes("event: error"))).toBe(true);
    });

    test("should not write when response already ended", async () => {
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "test" };
        mockRes.writableEnded = true;
        throw new Error("Error after ended");
      }

      await streamManager.stream(mockRes as any, generator);

      expect(events).toContain('data: {"type":"test"}\n\n');
      expect(events.filter((e) => e.includes("Error after ended")).length).toBe(
        0,
      );
    });
  });

  describe("heartbeat", () => {
    test("should send heartbeat messages periodically", async () => {
      vi.useFakeTimers();
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "start" };
        await new Promise((resolve) => setTimeout(resolve, 50000));
        yield { type: "end" };
      }

      const streamPromise = streamManager.stream(mockRes as any, generator);
      await vi.advanceTimersByTimeAsync(50000);
      await streamPromise;

      const heartbeats = events.filter((e) => e === ": heartbeat\n\n");
      expect(heartbeats.length).toBeGreaterThanOrEqual(3);

      vi.useRealTimers();
    });

    test("should stop heartbeat after stream ends", async () => {
      vi.useFakeTimers();
      const { mockRes, events } = createMockResponse();

      async function* generator() {
        yield { type: "done" };
      }

      await streamManager.stream(mockRes as any, generator);

      const heartbeatsBefore = events.filter(
        (e) => e === ": heartbeat\n\n",
      ).length;
      await vi.advanceTimersByTimeAsync(30000);
      const heartbeatsAfter = events.filter(
        (e) => e === ": heartbeat\n\n",
      ).length;

      expect(heartbeatsAfter).toBe(heartbeatsBefore);

      vi.useRealTimers();
    });

    test("should not crash if heartbeat writes after disconnect", async () => {
      vi.useFakeTimers();
      const { mockRes } = createMockResponse();

      let disconnectHandler: (() => void) | undefined;
      mockRes.on.mockImplementation((event: string, handler: () => void) => {
        if (event === "close") disconnectHandler = handler;
      });

      async function* generator() {
        yield { type: "start" };
        await new Promise((resolve) => setTimeout(resolve, 30000));
        yield { type: "end" };
      }

      const streamPromise = streamManager.stream(mockRes as any, generator);

      await vi.advanceTimersByTimeAsync(15000);
      const heartbeatsBefore = mockRes.write.mock.calls.filter(
        (call) => call[0] === ": heartbeat\n\n",
      ).length;
      expect(heartbeatsBefore).toBe(1);

      mockRes.writableEnded = true;
      if (disconnectHandler) disconnectHandler();

      await vi.advanceTimersByTimeAsync(15000);
      const heartbeatsAfter = mockRes.write.mock.calls.filter(
        (call) => call[0] === ": heartbeat\n\n",
      ).length;
      expect(heartbeatsAfter).toBe(1);

      await streamPromise;
      vi.useRealTimers();
    });
  });

  describe("reconnection", () => {
    test("should handle missing req.headers gracefully", async () => {
      const { mockRes } = createMockResponse();
      delete (mockRes as any).req;

      async function* generator() {
        yield { type: "test" };
      }

      await expect(
        streamManager.stream(mockRes as any, generator, {
          streamId: "test-123",
        }),
      ).resolves.not.toThrow();

      expect(mockRes.write).toHaveBeenCalled();
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should replay missed events on reconnection", async () => {
      const streamId = "test-reconnect-123";

      const { mockRes: mockRes1, events: events1 } = createMockResponse();

      async function* generator1() {
        yield { type: "message", data: "event1" };
        yield { type: "message", data: "event2" };
        yield { type: "message", data: "event3" };
      }

      await streamManager.stream(mockRes1 as any, generator1, { streamId });

      const eventIds = events1
        .filter((e) => e.startsWith("id: "))
        .map((e) => e.replace("id: ", "").replace("\n", ""));

      expect(eventIds.length).toBe(3);

      const { mockRes: mockRes2, events: events2 } = createMockResponse({
        "last-event-id": eventIds[1],
      });

      async function* generator2() {
        yield { type: "message", data: "should-not-appear" };
      }

      await streamManager.stream(mockRes2 as any, generator2, { streamId });

      const replayedData = events2
        .filter((e) => e.startsWith("data: "))
        .map((e) => e.replace("data: ", "").replace("\n\n", ""));

      expect(replayedData.length).toBe(1);
      expect(replayedData[0]).toContain("event3");
      expect(mockRes2.end).toHaveBeenCalled();
    });

    test("should include error events in replay buffer", async () => {
      const streamId = "error-reconnect-456";

      const { mockRes: mockRes1, events: events1 } = createMockResponse();

      async function* generator() {
        yield { type: "message", data: "event1" };
        yield { type: "message", data: "event2" };
        throw new Error("Something went wrong");
      }

      await streamManager.stream(mockRes1 as any, generator, { streamId });

      const eventIds = events1
        .filter((e) => e.startsWith("id: "))
        .map((e) => e.replace("id: ", "").replace("\n", ""));

      expect(eventIds.length).toBe(3);

      const { mockRes: mockRes2, events: events2 } = createMockResponse({
        "last-event-id": eventIds[0],
      });

      async function* generator2() {
        yield { type: "should-not-appear" };
      }

      await streamManager.stream(mockRes2 as any, generator2, { streamId });

      const replayedError = events2.some((e) =>
        e.includes("Something went wrong"),
      );
      expect(replayedError).toBe(true);
    });

    test("should detect buffer overflow and restart stream", async () => {
      const streamId = "overflow-test-123";

      const { mockRes: mockRes1 } = createMockResponse();

      async function* generator1() {
        for (let i = 0; i < 150; i++) {
          yield { type: "message", count: i };
        }
      }

      await streamManager.stream(mockRes1 as any, generator1, {
        streamId,
        bufferSize: 100,
      });

      const events1: string[] = mockRes1.write.mock.calls.map(
        (call) => call[0],
      );

      const firstEventId = events1.find((e) => e.startsWith("id: "));
      expect(firstEventId).toBeDefined();

      if (!firstEventId) {
        throw new Error("First event id not found");
      }

      const cleanEventId = firstEventId.replace("id: ", "").replace("\n", "");

      const { mockRes: mockRes2, events: events2 } = createMockResponse({
        "last-event-id": cleanEventId,
      });

      async function* generator2() {
        yield { type: "new-stream", data: "restarted" };
      }

      await streamManager.stream(mockRes2 as any, generator2, { streamId });

      const hasWarning = events2.some(
        (e) =>
          e.includes("event: warning") || e.includes("BUFFER_OVERFLOW_RESTART"),
      );
      expect(hasWarning).toBe(true);

      const hasNewStream = events2.some((e) => e.includes("restarted"));
      expect(hasNewStream).toBe(true);
    });

    test("should replay successfully when within buffer capacity", async () => {
      const streamId = "no-overflow-test-456";

      const { mockRes: mockRes1, events: events1 } = createMockResponse();

      async function* generator1() {
        for (let i = 0; i < 50; i++) {
          yield { type: "message", count: i };
        }
      }

      await streamManager.stream(mockRes1 as any, generator1, {
        streamId,
        bufferSize: 100,
      });

      const firstEventId = events1.filter((e) => e.startsWith("id: "))[0];

      expect(firstEventId).toBeDefined();

      const cleanEventId = firstEventId.replace("id: ", "").replace("\n", "");

      const { mockRes: mockRes2, events: events2 } = createMockResponse({
        "last-event-id": cleanEventId,
      });

      async function* generator2() {
        yield { type: "should-not-appear" };
      }

      await streamManager.stream(mockRes2 as any, generator2, { streamId });

      expect(events2.some((e) => e.includes("BUFFER_OVERFLOW_RESTART"))).toBe(
        false,
      );
      expect(
        events2.filter((e) => e.startsWith("data: ")).length,
      ).toBeGreaterThan(0);
      expect(events2.some((e) => e.includes("should-not-appear"))).toBe(false);
    });
  });
});

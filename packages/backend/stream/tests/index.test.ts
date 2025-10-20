import { beforeEach, describe, expect, test, vi } from "vitest";
import { StreamManager } from "../src/index";

// Mock response object that mimics Express response
function createMockResponse() {
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
  };
  return { mockRes, events };
}

describe("StreamManager", () => {
  let streamManager: StreamManager;

  beforeEach(() => {
    streamManager = new StreamManager();
    vi.clearAllMocks();
  });

  describe("stream with multiple messages", () => {
    test("should yield multiple messages in correct order", async () => {
      const { mockRes, events } = createMockResponse();

      async function* testGenerator() {
        yield { type: "start", message: "Starting" };
        yield { type: "progress", message: "Processing" };
        yield { type: "progress", message: "Almost done" };
        yield { type: "complete", message: "Finished" };
      }

      await streamManager.stream(mockRes as any, testGenerator);

      // Verify SSE headers were set
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "no-cache",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Connection",
        "keep-alive",
      );
      expect(mockRes.flushHeaders).toHaveBeenCalled();

      // Verify all messages were written in order
      expect(events).toContain("event: start\n");
      expect(events).toContain(
        'data: {"type":"start","message":"Starting"}\n\n',
      );

      expect(events).toContain("event: progress\n");
      expect(events).toContain(
        'data: {"type":"progress","message":"Processing"}\n\n',
      );
      expect(events).toContain(
        'data: {"type":"progress","message":"Almost done"}\n\n',
      );

      expect(events).toContain("event: complete\n");
      expect(events).toContain(
        'data: {"type":"complete","message":"Finished"}\n\n',
      );

      // Verify order: start -> progress -> progress -> complete
      const startIndex = events.findIndex((e) => e.includes("Starting"));
      const processingIndex = events.findIndex((e) => e.includes("Processing"));
      const almostDoneIndex = events.findIndex((e) =>
        e.includes("Almost done"),
      );
      const finishedIndex = events.findIndex((e) => e.includes("Finished"));

      expect(startIndex).toBeLessThan(processingIndex);
      expect(processingIndex).toBeLessThan(almostDoneIndex);
      expect(almostDoneIndex).toBeLessThan(finishedIndex);

      // Verify stream ended properly
      expect(mockRes.end).toHaveBeenCalled();
      expect(streamManager.getActiveCount()).toBe(0);
    });

    test("should use default 'message' type when type is not provided", async () => {
      const { mockRes, events } = createMockResponse();

      async function* testGenerator() {
        yield { data: "test without type" };
      }

      await streamManager.stream(mockRes as any, testGenerator);

      expect(events).toContain("event: message\n");
      expect(events).toContain('data: {"data":"test without type"}\n\n');
      expect(mockRes.end).toHaveBeenCalled();
    });
  });

  describe("SSE format validation", () => {
    test("should follow correct SSE format: event -> data -> empty line", async () => {
      const { mockRes, events } = createMockResponse();

      async function* testGenerator() {
        yield { type: "test", value: 123 };
      }

      await streamManager.stream(mockRes as any, testGenerator);

      // Find the event and data lines
      const eventIndex = events.indexOf("event: test\n");
      const dataIndex = events.findIndex((e) =>
        e.includes('{"type":"test","value":123}'),
      );

      expect(eventIndex).toBeGreaterThanOrEqual(0);
      expect(dataIndex).toBe(eventIndex + 1);
      expect(events[dataIndex]).toBe('data: {"type":"test","value":123}\n\n');
    });

    test("should sanitize event types to prevent SSE injection", async () => {
      const { mockRes, events } = createMockResponse();

      async function* maliciousGenerator() {
        // Attempt to inject SSE data via newlines in event type
        yield { type: 'test\ndata: {"injected":true}', message: "test" };
      }

      await streamManager.stream(mockRes as any, maliciousGenerator);

      // The word "injected" will appear in the data field (which is correct)
      // but should NOT appear as a separate SSE data line (injection attack)

      // Event type should be sanitized (newlines removed)
      const eventLine = events.find((e) => e.startsWith("event: "));
      expect(eventLine).toBe('event: testdata: {"injected":true}\n');

      // Should NOT have created a separate malicious data: line
      // The full event should be in a single data: line with the whole object
      const dataLines = events.filter((e) => e.startsWith("data: "));
      expect(dataLines.length).toBe(1);

      // The data line should contain the full JSON with type field intact
      expect(dataLines[0]).toContain(
        '"type":"test\\ndata: {\\"injected\\":true}"',
      );
    });

    test("should limit event type length", async () => {
      const { mockRes, events } = createMockResponse();

      async function* longTypeGenerator() {
        // Very long event type (over 100 chars)
        yield { type: "a".repeat(200), message: "test" };
      }

      await streamManager.stream(mockRes as any, longTypeGenerator);

      // Event type should be limited to 100 characters
      const eventLine = events.find((e) => e.startsWith("event: "));
      const eventType = eventLine?.replace("event: ", "").replace("\n", "");
      expect(eventType?.length).toBeLessThanOrEqual(100);
    });
  });

  describe("AbortSignal and cancellation", () => {
    test("should pass AbortSignal to handler", async () => {
      const { mockRes } = createMockResponse();
      let receivedSignal: AbortSignal | undefined;

      async function* testGenerator(signal: AbortSignal) {
        receivedSignal = signal;
        yield { type: "test" };
      }

      await streamManager.stream(mockRes as any, testGenerator);

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });

    test("should stop streaming when signal is aborted", async () => {
      const { mockRes, events } = createMockResponse();
      const abortController = new AbortController();

      async function* testGenerator(signal: AbortSignal) {
        yield { type: "start", message: "First" };

        // Abort after first message
        abortController.abort();

        // This should not be yielded
        if (!signal.aborted) {
          yield { type: "end", message: "Should not appear" };
        }
      }

      await streamManager.stream(mockRes as any, testGenerator, {
        userSignal: abortController.signal,
      });

      // Should only have the first message
      expect(events).toContain('data: {"type":"start","message":"First"}\n\n');
      expect(events).not.toContain("Should not appear");
    });

    test("should handle client disconnect", async () => {
      const { mockRes } = createMockResponse();
      let closeHandler: (() => void) | undefined;

      // Capture the 'close' event handler
      mockRes.on.mockImplementation((event: string, handler: () => void) => {
        if (event === "close") {
          closeHandler = handler;
        }
      });

      async function* testGenerator(_signal: AbortSignal) {
        yield { type: "test" };
      }

      const streamPromise = streamManager.stream(mockRes as any, testGenerator);

      // Verify active operation was tracked
      expect(streamManager.getActiveCount()).toBe(1);

      // Simulate client disconnect
      if (closeHandler) {
        closeHandler();
      }

      await streamPromise;

      // Verify cleanup happened
      expect(streamManager.getActiveCount()).toBe(0);
    });
  });

  describe("abortAll - graceful shutdown", () => {
    test("should abort all active streams", async () => {
      const { mockRes: mockRes1 } = createMockResponse();
      const { mockRes: mockRes2 } = createMockResponse();

      async function* longRunningGenerator(signal: AbortSignal) {
        let count = 0;
        while (!signal.aborted && count < 100) {
          yield { type: "progress", count: count++ };
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      // Start two streams
      const stream1Promise = streamManager.stream(
        mockRes1 as any,
        longRunningGenerator,
      );
      const stream2Promise = streamManager.stream(
        mockRes2 as any,
        longRunningGenerator,
      );

      // Wait a bit to ensure streams are active
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Verify both streams are active
      expect(streamManager.getActiveCount()).toBe(2);

      // Abort all
      streamManager.abortAll();

      // Wait for streams to complete
      await Promise.all([stream1Promise, stream2Promise]);

      // Verify all streams were cleaned up
      expect(streamManager.getActiveCount()).toBe(0);
    });
  });

  describe("error handling", () => {
    test("should send error event when handler throws", async () => {
      const { mockRes, events } = createMockResponse();

      async function* errorGenerator() {
        yield { type: "start", message: "Starting" };
        throw new Error("Test error");
      }

      await streamManager.stream(mockRes as any, errorGenerator);

      // Should have the start message
      expect(events).toContain(
        'data: {"type":"start","message":"Starting"}\n\n',
      );

      // Should have error event
      expect(events).toContain("event: error\n");
      expect(events).toContain('data: {"error":"Test error"}\n\n');

      // Should end the stream
      expect(mockRes.end).toHaveBeenCalled();

      // Should cleanup
      expect(streamManager.getActiveCount()).toBe(0);
    });

    test("should handle non-Error exceptions", async () => {
      const { mockRes, events } = createMockResponse();

      async function* errorGenerator() {
        yield { type: "start", message: "Starting" };
        throw "String error";
      }

      await streamManager.stream(mockRes as any, errorGenerator);

      expect(events).toContain("event: error\n");
      expect(events).toContain('data: {"error":"Internal server error"}\n\n');
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should not write after stream is aborted", async () => {
      const { mockRes } = createMockResponse();
      const abortController = new AbortController();

      async function* testGenerator() {
        yield { type: "first" };
        abortController.abort();
        // Should not write this
        yield { type: "second" };
      }

      await streamManager.stream(mockRes as any, testGenerator, {
        userSignal: abortController.signal,
      });

      // mockRes.write should only be called for headers and first message
      const writeCalls = mockRes.write.mock.calls.filter((call) =>
        call[0].includes("second"),
      );
      expect(writeCalls).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    test("should send heartbeat messages periodically", async () => {
      vi.useFakeTimers();
      const { mockRes, events } = createMockResponse();

      async function* longGenerator() {
        yield { type: "start" };

        // Wait for heartbeats to be sent
        await new Promise((resolve) => {
          setTimeout(resolve, 50000); // 50 seconds in fake time
        });

        yield { type: "end" };
      }

      const streamPromise = streamManager.stream(mockRes as any, longGenerator);

      // Advance time by 50 seconds (more than 3 heartbeat intervals)
      await vi.advanceTimersByTimeAsync(50000);

      await streamPromise;

      // Should have at least 3 heartbeats (every 15 seconds)
      const heartbeats = events.filter((e) => e === ": heartbeat\n\n");
      expect(heartbeats.length).toBeGreaterThanOrEqual(3);

      vi.useRealTimers();
    });

    test("heartbeat should stop after stream ends", async () => {
      vi.useFakeTimers();
      const { mockRes, events } = createMockResponse();

      async function* quickGenerator() {
        yield { type: "done" };
      }

      await streamManager.stream(mockRes as any, quickGenerator);

      const heartbeatsBeforeAdvance = events.filter(
        (e) => e === ": heartbeat\n\n",
      ).length;

      // Advance time after stream ended
      await vi.advanceTimersByTimeAsync(30000);

      const heartbeatsAfterAdvance = events.filter(
        (e) => e === ": heartbeat\n\n",
      ).length;

      // Should not have new heartbeats after stream ended
      expect(heartbeatsAfterAdvance).toBe(heartbeatsBeforeAdvance);

      vi.useRealTimers();
    });
  });

  describe("combined signals", () => {
    test("should abort when user signal is aborted", async () => {
      const { mockRes } = createMockResponse();
      const userAbortController = new AbortController();

      let wasAborted = false;
      async function* testGenerator(signal: AbortSignal) {
        yield { type: "start" };

        // Abort from user
        userAbortController.abort();

        // Small delay to let abort propagate
        await new Promise((resolve) => setTimeout(resolve, 10));

        if (signal.aborted) {
          wasAborted = true;
        }
      }

      await streamManager.stream(mockRes as any, testGenerator, {
        userSignal: userAbortController.signal,
      });

      expect(wasAborted).toBe(true);
    });

    test("should abort when internal signal is aborted via abortAll", async () => {
      const { mockRes } = createMockResponse();

      let wasAborted = false;
      async function* testGenerator(signal: AbortSignal) {
        yield { type: "start" };

        // Abort from server
        streamManager.abortAll();

        // Small delay to let abort propagate
        await new Promise((resolve) => setTimeout(resolve, 10));

        if (signal.aborted) {
          wasAborted = true;
        }
      }

      await streamManager.stream(mockRes as any, testGenerator);

      expect(wasAborted).toBe(true);
    });
  });

  describe("getActiveCount", () => {
    test("should track active operations correctly", async () => {
      const { mockRes: mockRes1 } = createMockResponse();
      const { mockRes: mockRes2 } = createMockResponse();

      async function* testGenerator() {
        yield { type: "test" };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(streamManager.getActiveCount()).toBe(0);

      const promise1 = streamManager.stream(mockRes1 as any, testGenerator);
      const promise2 = streamManager.stream(mockRes2 as any, testGenerator);

      // Should have 2 active operations
      expect(streamManager.getActiveCount()).toBe(2);

      await Promise.all([promise1, promise2]);

      // Should be cleaned up
      expect(streamManager.getActiveCount()).toBe(0);
    });
  });

  describe("edge cases and error conditions", () => {
    test("should not write or end if res.writableEnded is true", async () => {
      const { mockRes } = createMockResponse();
      mockRes.writableEnded = true;

      async function* testGenerator() {
        yield { type: "test", message: "should not be written" };
      }

      await streamManager.stream(mockRes as any, testGenerator);

      // Headers should still be set (happens at the start)
      expect(mockRes.setHeader).toHaveBeenCalled();

      // But res.end should NOT be called since writableEnded is true
      expect(mockRes.end).not.toHaveBeenCalled();
    });

    test("should handle error thrown during iteration (not before)", async () => {
      const { mockRes, events } = createMockResponse();

      async function* errorMidStream() {
        yield { type: "first", message: "Message 1" };
        yield { type: "second", message: "Message 2" };
        throw new Error("Error in the middle");
      }

      await streamManager.stream(mockRes as any, errorMidStream);

      // Should have both messages before error
      expect(events).toContain(
        'data: {"type":"first","message":"Message 1"}\n\n',
      );
      expect(events).toContain(
        'data: {"type":"second","message":"Message 2"}\n\n',
      );

      // Should have error event
      expect(events).toContain("event: error\n");
      expect(events).toContain('data: {"error":"Error in the middle"}\n\n');

      // Should end the stream
      expect(mockRes.end).toHaveBeenCalled();

      // Should cleanup
      expect(streamManager.getActiveCount()).toBe(0);
    });

    test("should handle missing flushHeaders method", async () => {
      const { mockRes, events } = createMockResponse();
      mockRes.flushHeaders = undefined as any;

      async function* testGenerator() {
        yield { type: "test" };
      }

      // Should not throw error
      await expect(
        streamManager.stream(mockRes as any, testGenerator),
      ).resolves.not.toThrow();

      // Should still work normally
      expect(events).toContain('data: {"type":"test"}\n\n');
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should handle pre-aborted signal in options", async () => {
      const { mockRes } = createMockResponse();
      const preAbortedController = new AbortController();
      preAbortedController.abort("Already aborted");

      async function* testGenerator(signal: AbortSignal) {
        // Signal should be aborted from the start
        expect(signal.aborted).toBe(true);
        yield { type: "test" };
      }

      await streamManager.stream(mockRes as any, testGenerator, {
        userSignal: preAbortedController.signal,
      });

      // Should cleanup even with pre-aborted signal
      expect(streamManager.getActiveCount()).toBe(0);
    });

    test("heartbeat should not write when signal is aborted", async () => {
      vi.useFakeTimers();
      const { mockRes, events } = createMockResponse();
      const abortController = new AbortController();

      async function* testGenerator() {
        yield { type: "start" };

        // Abort immediately
        abortController.abort();

        // Wait for heartbeat interval (15s)
        await new Promise((resolve) => setTimeout(resolve, 16000));
      }

      const streamPromise = streamManager.stream(
        mockRes as any,
        testGenerator,
        {
          userSignal: abortController.signal,
        },
      );

      // Advance time past heartbeat interval
      await vi.advanceTimersByTimeAsync(16000);

      await streamPromise;

      // Should not have heartbeats since signal was aborted
      const heartbeats = events.filter((e) => e === ": heartbeat\n\n");
      expect(heartbeats.length).toBe(0);

      vi.useRealTimers();
    });

    test("should cleanup (heartbeat and operation) even when error occurs", async () => {
      const { mockRes } = createMockResponse();

      async function* errorGenerator() {
        yield { type: "test" };
        throw new Error("Test cleanup on error");
      }

      // Verify operation is tracked
      const streamPromise = streamManager.stream(
        mockRes as any,
        errorGenerator,
      );

      expect(streamManager.getActiveCount()).toBe(1);

      await streamPromise;

      // Should cleanup even with error
      expect(streamManager.getActiveCount()).toBe(0);
    });

    test("should not write error if response is already ended", async () => {
      const { mockRes, events } = createMockResponse();

      async function* errorGenerator() {
        yield { type: "test" };
        // Simulate response already ended
        mockRes.writableEnded = true;
        throw new Error("Error after ended");
      }

      await streamManager.stream(mockRes as any, errorGenerator);

      // Should have the first message
      expect(events).toContain('data: {"type":"test"}\n\n');

      // Should NOT have error event (response already ended)
      const errorEvents = events.filter((e) => e.includes("Error after ended"));
      expect(errorEvents.length).toBe(0);
    });

    test("should not end response if signal is aborted", async () => {
      const { mockRes } = createMockResponse();
      const abortController = new AbortController();

      async function* testGenerator() {
        yield { type: "test" };
        abortController.abort();
      }

      await streamManager.stream(mockRes as any, testGenerator, {
        userSignal: abortController.signal,
      });

      // Should NOT call res.end() when aborted
      expect(mockRes.end).not.toHaveBeenCalled();
    });

    test("should handle empty generator (no yields)", async () => {
      const { mockRes } = createMockResponse();

      async function* emptyGenerator() {
        // No yields
      }

      await streamManager.stream(mockRes as any, emptyGenerator);

      // Should still setup headers
      expect(mockRes.setHeader).toHaveBeenCalled();

      // Should end the stream
      expect(mockRes.end).toHaveBeenCalled();

      // Should cleanup
      expect(streamManager.getActiveCount()).toBe(0);
    });
  });
});

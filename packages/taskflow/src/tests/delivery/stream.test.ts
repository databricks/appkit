import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eventId,
  idempotencyKey,
  taskId,
  taskName,
  userId,
} from "@/core/branded";
import { StreamOverflowError, ValidationError } from "@/core/errors";
import { StreamManager } from "@/delivery/stream";
import type { TaskEvent } from "@/domain";
import { noopHooks, type TaskSystemHooks } from "@/observability";

function createMockEvent(overrides?: Partial<TaskEvent>): TaskEvent {
  return {
    id: eventId(overrides?.id ?? crypto.randomUUID()),
    type: "progress",
    taskId: taskId("task-123"),
    name: taskName("test-task"),
    idempotencyKey: idempotencyKey("a".repeat(64)),
    userId: userId("user-123"),
    taskType: "user",
    message: "Test event",
    ...overrides,
  } as TaskEvent;
}

describe("StreamManager", () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager({
      streamRetentionMs: 1000,
      streamBufferSize: 10,
    });
  });

  afterEach(() => {
    manager.clearAll();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("getOrCreate", () => {
    it("should create a new stream when it does not exist", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream = manager.getOrCreate(key);

      expect(stream).toBeDefined();
      expect(stream.closed).toBe(false);
      expect(stream.nextSeq).toBe(1);
      expect(stream.listeners.size).toBe(0);
    });

    it("should return existing stream when already created", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream1 = manager.getOrCreate(key);
      const stream2 = manager.getOrCreate(key);

      expect(stream1).toBe(stream2);
    });

    it("should create separate streams for different keys", () => {
      const key1 = idempotencyKey("a".repeat(64));
      const key2 = idempotencyKey("b".repeat(64));
      const stream1 = manager.getOrCreate(key1);
      const stream2 = manager.getOrCreate(key2);

      expect(stream1).not.toBe(stream2);
    });
  });

  describe("get", () => {
    it("should return stream if exists", () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);
      const stream = manager.get(key);

      expect(stream).toBeDefined();
    });

    it("should return undefined if stream does not exist", () => {
      const key = idempotencyKey("z".repeat(64));
      const stream = manager.get(key);

      expect(stream).toBeUndefined();
    });
  });

  describe("push", () => {
    it("should add event to buffer with seq number", () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);
      const event = createMockEvent();

      manager.push(key, event);

      const stream = manager.get(key);
      const events = stream?.buffer.getAll();
      expect(events).toHaveLength(1);
      expect(events?.[0].seq).toBe(1);
    });

    it("should increment seq on each push", () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);

      manager.push(key, createMockEvent());
      manager.push(key, createMockEvent());
      manager.push(key, createMockEvent());

      const stream = manager.get(key);
      const events = stream?.buffer.getAll();
      expect(events?.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("should notify listeners", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream = manager.getOrCreate(key);
      const listener = vi.fn();
      stream.listeners.add(listener);

      manager.push(key, createMockEvent());

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should do nothing if stream does not exist", () => {
      const key = idempotencyKey("z".repeat(64));
      expect(() => manager.push(key, createMockEvent())).not.toThrow();
    });
  });

  describe("close", () => {
    it("should mark stream as closed", () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);

      manager.close(key);

      const stream = manager.get(key);
      expect(stream?.closed).toBe(true);
    });

    it("should notify listeners when closing", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream = manager.getOrCreate(key);
      const listener = vi.fn();
      stream.listeners.add(listener);

      manager.close(key);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should clear listeners after closing", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream = manager.getOrCreate(key);
      stream.listeners.add(vi.fn());
      stream.listeners.add(vi.fn());

      manager.close(key);

      expect(stream.listeners.size).toBe(0);
    });

    it("should not close if already closed", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream = manager.getOrCreate(key);
      const listener = vi.fn();

      manager.close(key);
      stream.listeners.add(listener);
      manager.close(key);

      expect(listener).not.toHaveBeenCalled();
    });

    it("should do nothing if stream does not exist", () => {
      const key = idempotencyKey("z".repeat(64));
      expect(() => manager.close(key)).not.toThrow();
    });

    it("should schedule cleanup after retention period", () => {
      vi.useFakeTimers();
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);
      manager.close(key);

      expect(manager.get(key)).toBeDefined();

      vi.advanceTimersByTime(1100);

      expect(manager.get(key)).toBeUndefined();
    });
  });

  describe("createGenerator", () => {
    it("should yield events in order", async () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);
      manager.push(key, createMockEvent({ message: "Event 1" }));
      manager.push(key, createMockEvent({ message: "Event 2" }));
      manager.close(key);

      const generator = manager.createGenerator(key);
      const events: TaskEvent[] = [];

      for await (const event of generator) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].message).toBe("Event 1");
      expect(events[1].message).toBe("Event 2");
    });

    it("should wait for new events", async () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);

      const generator = manager.createGenerator(key);
      const events: TaskEvent[] = [];

      const collectPromise = (async () => {
        for await (const event of generator) {
          events.push(event);
          if (events.length === 2) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      manager.push(key, createMockEvent({ message: "Event 1" }));

      await new Promise((r) => setTimeout(r, 10));
      manager.push(key, createMockEvent({ message: "Event 2" }));

      await collectPromise;

      expect(events).toHaveLength(2);
    });

    it("should return when stream is closed", async () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);
      manager.push(key, createMockEvent());

      const generator = manager.createGenerator(key);
      const events: TaskEvent[] = [];

      const collectPromise = (async () => {
        for await (const event of generator) {
          events.push(event);
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      manager.close(key);

      await collectPromise;

      expect(events).toHaveLength(1);
    });

    it("should return immediately if stream does not exist", async () => {
      const key = idempotencyKey("z".repeat(64));
      const generator = manager.createGenerator(key);
      const events: TaskEvent[] = [];

      for await (const event of generator) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });

    it("should support lastSeq for reconnection", async () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);
      manager.push(key, createMockEvent({ message: "Event 1" }));
      manager.push(key, createMockEvent({ message: "Event 2" }));
      manager.push(key, createMockEvent({ message: "Event 3" }));
      manager.close(key);

      const generator = manager.createGenerator(key, { lastSeq: 1 });
      const events: TaskEvent[] = [];

      for await (const event of generator) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].message).toBe("Event 2");
      expect(events[1].message).toBe("Event 3");
    });

    it("should throw StreamOverflowError when lastSeq is evicted from buffer", async () => {
      const smallBufferManager = new StreamManager({
        streamBufferSize: 10,
        streamRetentionMs: 1000,
      });

      const key = idempotencyKey("a".repeat(64));
      smallBufferManager.getOrCreate(key);

      for (let i = 1; i <= 15; i++) {
        smallBufferManager.push(
          key,
          createMockEvent({ message: `Event ${i}` }),
        );
      }
      smallBufferManager.close(key);

      const generator = smallBufferManager.createGenerator(key, {
        lastSeq: 1,
      });

      await expect(async () => {
        for await (const _ of generator) {
          // consume, do nothing
        }
      }).rejects.toThrow(StreamOverflowError);

      smallBufferManager.clearAll();
    });

    it("should support AbortSignal", async () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);

      const controller = new AbortController();
      const generator = manager.createGenerator(key, {
        signal: controller.signal,
      });

      const collectPromise = (async () => {
        const events: TaskEvent[] = [];
        try {
          for await (const event of generator) {
            events.push(event);
          }
        } catch {
          // expected abort
        }
        return events;
      })();

      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      const events = await collectPromise;
      expect(events).toHaveLength(0);
    });

    it("should reject with abort reason when aborted while waiting", async () => {
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);

      const controller = new AbortController();
      const generator = manager.createGenerator(key, {
        signal: controller.signal,
      });

      const collectPromise = (async () => {
        for await (const _ of generator) {
          // waiting for events
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      controller.abort(new Error("User cancelled"));

      await expect(collectPromise).rejects.toThrow("User cancelled");
    });
  });

  describe("clearAll", () => {
    it("should clear all streams", () => {
      const key1 = idempotencyKey("a".repeat(64));
      const key2 = idempotencyKey("b".repeat(64));
      const key3 = idempotencyKey("c".repeat(64));
      manager.getOrCreate(key1);
      manager.getOrCreate(key2);
      manager.getOrCreate(key3);

      manager.clearAll();

      expect(manager.get(key1)).toBeUndefined();
      expect(manager.get(key2)).toBeUndefined();
      expect(manager.get(key3)).toBeUndefined();
    });

    it("should clear cleanup timers", () => {
      vi.useFakeTimers();
      const key = idempotencyKey("a".repeat(64));
      manager.getOrCreate(key);
      manager.close(key);

      manager.clearAll();

      vi.advanceTimersByTime(200);
    });
  });

  describe("getListenerCount", () => {
    it("should return listener count", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream = manager.getOrCreate(key);
      stream.listeners.add(vi.fn());
      stream.listeners.add(vi.fn());

      expect(manager.getListenerCount(key)).toBe(2);
    });

    it("should return 0 if stream does not exist", () => {
      const key = idempotencyKey("z".repeat(64));
      expect(manager.getListenerCount(key)).toBe(0);
    });

    it("should return 0 after listeners are cleared", () => {
      const key = idempotencyKey("a".repeat(64));
      const stream = manager.getOrCreate(key);
      stream.listeners.add(vi.fn());

      manager.close(key);

      expect(manager.getListenerCount(key)).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should return comprehensive statistics", () => {
      const key1 = idempotencyKey("a".repeat(64));
      const key2 = idempotencyKey("b".repeat(64));
      manager.getOrCreate(key1);
      manager.getOrCreate(key2);
      manager.push(key1, createMockEvent());
      manager.push(key1, createMockEvent());
      manager.close(key2);

      const stats = manager.getStats();

      expect(stats.streams.active).toBe(1);
      expect(stats.streams.closed).toBe(1);
      expect(stats.streams.total).toBe(2);
      expect(stats.buffer.totalEvents).toBe(2);
      expect(stats.events.pushed).toBe(2);
    });
  });

  describe("configuration", () => {
    it("should use default config when not provided", () => {
      const defaultManager = new StreamManager();
      const key = idempotencyKey("a".repeat(64));
      const stream = defaultManager.getOrCreate(key);

      expect(stream.buffer).toBeDefined();
      defaultManager.clearAll();
    });

    it("should respect custom buffer size", () => {
      const customManager = new StreamManager({ streamBufferSize: 10 });
      const key = idempotencyKey("a".repeat(64));
      customManager.getOrCreate(key);

      for (let i = 0; i < 20; i++) {
        customManager.push(key, createMockEvent());
      }

      const stream = customManager.get(key);
      expect(stream?.buffer.getAll()).toHaveLength(10);

      customManager.clearAll();
    });
  });

  describe("validation", () => {
    it("should throw ValidationError for empty idempotencyKey in getOrCreate", () => {
      expect(() => manager.getOrCreate(idempotencyKey(""))).toThrow(
        ValidationError,
      );
    });

    it("should throw ValidationError for empty idempotencyKey in get", () => {
      expect(() => manager.get(idempotencyKey(""))).toThrow(ValidationError);
    });

    it("should throw ValidationError for empty idempotencyKey in push", () => {
      expect(() => manager.push(idempotencyKey(""), createMockEvent())).toThrow(
        ValidationError,
      );
    });

    it("should throw ValidationError for empty idempotencyKey in close", () => {
      expect(() => manager.close(idempotencyKey(""))).toThrow(ValidationError);
    });

    it("should throw ValidationError for empty idempotencyKey in createGenerator", async () => {
      const generator = manager.createGenerator(idempotencyKey(""));
      await expect(generator.next()).rejects.toThrow(ValidationError);
    });

    it("should throw ValidationError for empty idempotencyKey in getListenerCount", () => {
      expect(() => manager.getListenerCount(idempotencyKey(""))).toThrow(
        ValidationError,
      );
    });
  });

  describe("observability hooks", () => {
    it("should call incrementCounter on push", () => {
      const mockHooks: TaskSystemHooks = {
        ...noopHooks,
        incrementCounter: vi.fn(),
      };

      const hookedManager = new StreamManager(
        { streamBufferSize: 10, streamRetentionMs: 1000 },
        mockHooks,
      );

      const key = idempotencyKey("a".repeat(64));
      hookedManager.getOrCreate(key);
      hookedManager.push(key, createMockEvent());

      expect(mockHooks.incrementCounter).toHaveBeenCalled();

      hookedManager.clearAll();
    });
    it("should record gauge for active streams", () => {
      const mockHooks: TaskSystemHooks = {
        ...noopHooks,
        recordGauge: vi.fn(),
      };

      const hookedManager = new StreamManager(
        { streamBufferSize: 10, streamRetentionMs: 1000 },
        mockHooks,
      );

      const key = idempotencyKey("a".repeat(64));
      hookedManager.getOrCreate(key);

      expect(mockHooks.recordGauge).toHaveBeenCalled();

      hookedManager.clearAll();
    });
  });
});

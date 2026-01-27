import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { idempotencyKey, taskName, userId } from "@/core/branded";
import { ValidationError } from "@/core/errors";
import type { TaskEvent, TaskEventInput } from "@/domain/events";
import type {
  TaskDefinition,
  TaskHandler,
  TaskHandlerContext,
} from "@/domain/handler";
import { Task } from "@/domain/task";
import { TaskExecutor } from "@/execution/executor";
import type { ExecutorConfig } from "@/execution/types";
import type { EventLog } from "@/persistence/event-log";

function createMockEventLog(): EventLog {
  return {
    appendEvent: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    readEntriesFromCheckpoint: vi.fn().mockReturnValue([]),
    getCheckpoint: vi.fn().mockReturnValue(0),
    setCheckpoint: vi.fn(),
    getStats: vi.fn().mockReturnValue({}),
  } as unknown as EventLog;
}

interface MockTaskOptions {
  name?: string;
  input?: unknown;
  userId?: string | null;
  idempotencyKey?: string;
  type?: "background" | "user";
}

function createMockTask(options?: MockTaskOptions): Task {
  return new Task({
    name: taskName(options?.name ?? "test-task"),
    input: options?.input ?? { data: "test" },
    userId:
      options?.userId !== undefined
        ? userId(options.userId)
        : userId("user-123"),
    idempotencyKey: idempotencyKey(options?.idempotencyKey ?? "test-key-123"),
    type: options?.type ?? "user",
  });
}

function createMockDefinition(
  executeFn: (
    input: unknown,
    context: TaskHandlerContext,
  ) => Promise<unknown> | AsyncGenerator<TaskEventInput, unknown, unknown>,
): TaskDefinition {
  return {
    name: "test-task",
    handler: executeFn as TaskHandler<unknown, unknown>,
    defaultOptions: {},
  };
}

describe("TaskExecutor", () => {
  let executor: TaskExecutor;
  let mockEventLog: EventLog;
  let onEvent: Mock;
  let onComplete: Mock;
  let events: TaskEvent[];

  const fastConfig: Partial<ExecutorConfig> = {
    heartbeatIntervalMs: 1000,
    retry: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
    },
  };

  beforeEach(() => {
    events = [];
    mockEventLog = createMockEventLog();
    onEvent = vi.fn((_key: string, event: TaskEvent) => {
      events.push(event);
    });
    onComplete = vi.fn();
    executor = new TaskExecutor(fastConfig, {
      eventLog: mockEventLog,
      subscribers: { onEvent, onComplete },
    });
  });

  afterEach(() => {
    executor.abortAll();
    vi.clearAllMocks();
  });

  describe("execute", () => {
    it("should emit error when handler is not provided", async () => {
      const task = createMockTask();

      await executor.execute(task, undefined);

      expect(task.status).toBe("failed");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      expect(events[0].message).toContain("Handler for task");
      expect(onComplete).toHaveBeenCalledWith(task);
    });

    it("should emit start event and complete event on success", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      expect(task.status).toBe("completed");
      expect(task.startedAt).toBeDefined();
      expect(task.completedAt).toBeDefined();
      expect(task.durationMs).toBeGreaterThanOrEqual(0);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("start");
      expect(eventTypes).toContain("complete");
      expect(onComplete).toHaveBeenCalledWith(task);
    });

    it("should handle async generator handlers", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async function* () {
        yield { type: "progress", message: "Step 1" };
        yield { type: "progress", message: "Step 2" };
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      expect(task.status).toBe("completed");
      const progressEvents = events.filter((e) => e.type === "progress");
      expect(progressEvents).toHaveLength(2);
    });
  });

  describe("retry behavior", () => {
    it("should retry on retryable error with exponential backoff", async () => {
      const task = createMockTask();
      let attempts = 0;

      const definition = createMockDefinition(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("ECONNRESET");
        }
        return { result: "Success" };
      });

      await executor.execute(task, definition);

      expect(attempts).toBe(3);
      expect(task.status).toBe("completed");

      const retryEvents = events.filter((e) => e.type === "retry");
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0].nextRetryDelayMs).toBe(100);
      expect(retryEvents[1].nextRetryDelayMs).toBe(200);
    });

    it("should not retry on permanent error", async () => {
      const task = createMockTask();
      let attempts = 0;

      const definition = createMockDefinition(async () => {
        attempts++;
        throw new ValidationError("Invalid input", "field");
      });

      await executor.execute(task, definition);

      expect(attempts).toBe(1);
      expect(task.status).toBe("failed");
      expect(task.error).toContain("Invalid input");

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(false);
    });

    it("should fail after max attempts exhausted", async () => {
      const task = createMockTask();
      let attempts = 0;

      const definition = createMockDefinition(async () => {
        attempts++;
        throw new Error("timeout");
      });

      await executor.execute(task, definition);

      expect(attempts).toBe(3);
      expect(task.status).toBe("failed");

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].attempt).toBe(3);
      expect(errorEvents[0].maxAttempts).toBe(3);
    });

    it("should cap delay at maxDelayMs", async () => {
      const cappedExecutor = new TaskExecutor(
        {
          heartbeatIntervalMs: 1000,
          retry: {
            maxAttempts: 5,
            initialDelayMs: 500,
            maxDelayMs: 1000,
            backoffMultiplier: 2,
          },
        },
        {
          eventLog: mockEventLog,
          subscribers: { onEvent, onComplete },
        },
      );

      const task = createMockTask();
      let attempts = 0;

      const definition = createMockDefinition(async () => {
        attempts++;
        if (attempts < 4) {
          throw new Error("timeout");
        }
        return { result: "Success" };
      });

      await cappedExecutor.execute(task, definition);

      const retryEvents = events.filter((e) => e.type === "retry");
      expect(retryEvents[0].nextRetryDelayMs).toBe(500);
      expect(retryEvents[1].nextRetryDelayMs).toBe(1000);
      expect(retryEvents[2].nextRetryDelayMs).toBe(1000); // capped
    });
  });

  describe("abort", () => {
    it("should abort a running task", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async (_input, context) => {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 5000);
          context?.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new Error("Task aborted"));
          });
        });
        return { result: "Done" };
      });

      const executePromise = executor.execute(task, definition);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(executor.isExecuting(task.idempotencyKey)).toBe(true);

      executor.abort(task.idempotencyKey);

      await executePromise;

      expect(["cancelled", "failed"]).toContain(task.status);
      expect(onComplete).toHaveBeenCalled();
    });

    it("should do nothing when aborting non-existent task", () => {
      expect(() =>
        executor.abort(idempotencyKey("non-existent")),
      ).not.toThrow();
    });
  });

  describe("abortAll", () => {
    it("should abort all running tasks", async () => {
      const task1 = createMockTask({ idempotencyKey: "key-1" });
      const task2 = createMockTask({ idempotencyKey: "key-2" });

      const slowDefinition = createMockDefinition(async (_input, context) => {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 5000);
          context?.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new Error("Task aborted"));
          });
        });
        return { result: "Done" };
      });

      const promise1 = executor.execute(task1, slowDefinition);
      const promise2 = executor.execute(task2, slowDefinition);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(executor.isExecuting(idempotencyKey("key-1"))).toBe(true);
      expect(executor.isExecuting(idempotencyKey("key-2"))).toBe(true);

      executor.abortAll();

      await Promise.all([promise1, promise2]);

      expect(executor.isExecuting(idempotencyKey("key-1"))).toBe(false);
      expect(executor.isExecuting(idempotencyKey("key-2"))).toBe(false);
    });
  });

  describe("isExecuting", () => {
    it("should return true while task is executing", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { result: "Done" };
      });

      const executePromise = executor.execute(task, definition);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(executor.isExecuting(task.idempotencyKey)).toBe(true);

      await executePromise;
      expect(executor.isExecuting(task.idempotencyKey)).toBe(false);
    });

    it("should return false for non-existent task", () => {
      expect(executor.isExecuting(idempotencyKey("non-existent"))).toBe(false);
    });
  });

  describe("heartbeat", () => {
    it("should emit heartbeat events periodically", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      const heartbeatEvents = events.filter((e) => e.type === "heartbeat");
      expect(heartbeatEvents.length).toBeGreaterThanOrEqual(2);
      expect(heartbeatEvents[0].timestamp).toBeDefined();
      expect(task.lastHeartbeatAt).toBeDefined();
    }, 10000);

    it("should stop heartbeat after task completes", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      const heartbeatCountBefore = events.filter(
        (e) => e.type === "heartbeat",
      ).length;

      await new Promise((resolve) => setTimeout(resolve, 100));

      const heartbeatCountAfter = events.filter(
        (e) => e.type === "heartbeat",
      ).length;

      expect(heartbeatCountAfter).toBe(heartbeatCountBefore);
    });
  });

  describe("error handling", () => {
    it("should track error message from Error instance", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        throw new Error("Something went wrong");
      });

      await executor.execute(task, definition);

      expect(task.error).toBe("Something went wrong");
    });

    it("should convert non-Error to string", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        throw "String error";
      });

      await executor.execute(task, definition);

      expect(task.error).toBe("String error");
    });

    it("should include attempt info in error event", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        throw new ValidationError("Bad input");
      });

      await executor.execute(task, definition);

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent?.attempt).toBe(1);
      expect(errorEvent?.maxAttempts).toBe(3);
    });
  });

  describe("duration tracking", () => {
    it("should calculate duration on success", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      expect(task.durationMs).toBeGreaterThanOrEqual(50);
      const completeEvent = events.find((e) => e.type === "complete");
      expect(completeEvent?.durationMs).toBeGreaterThanOrEqual(50);
    });

    it("should calculate duration on failure", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new ValidationError("Bad");
      });

      await executor.execute(task, definition);

      expect(task.durationMs).toBeGreaterThanOrEqual(30);
    });
  });

  describe("EventLog persistence", () => {
    it("should persist all events to EventLog", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      expect(mockEventLog.appendEvent).toHaveBeenCalled();
      const calls = vi.mocked(mockEventLog.appendEvent).mock.calls;
      const eventTypes = calls.map((call) => call[0].type);

      expect(eventTypes).toContain("start");
      expect(eventTypes).toContain("complete");
    });

    it("should persist events before broadcasting to subscribers (WAL-first)", async () => {
      const callOrder: string[] = [];

      const orderedEventLog = {
        appendEvent: vi.fn(() => {
          callOrder.push("eventLog");
        }),
      } as unknown as EventLog;

      const orderedOnEvent = vi.fn(() => {
        callOrder.push("subscriber");
      });

      const orderedExecutor = new TaskExecutor(fastConfig, {
        eventLog: orderedEventLog,
        subscribers: { onEvent: orderedOnEvent },
      });

      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        return { result: "Done" };
      });

      await orderedExecutor.execute(task, definition);

      // verify WAL-first pattern
      for (let i = 0; i < callOrder.length - 1; i += 2) {
        expect(callOrder[i]).toBe("eventLog");
        expect(callOrder[i + 1]).toBe("subscriber");
      }
    });

    it("should include correct task metadata in persisted events", async () => {
      const task = createMockTask({
        name: "my-task",
        idempotencyKey: "idem-456",
        userId: "user-789",
        type: "background",
      });
      const definition = createMockDefinition(async () => {
        return { result: "Done" };
      });
      definition.name = "my-task";

      await executor.execute(task, definition);

      const calls = vi.mocked(mockEventLog.appendEvent).mock.calls;
      const startEvent = calls.find((call) => call[0].type === "start")?.[0];

      expect(startEvent).toBeDefined();
      expect(startEvent?.taskId).toBe(task.id);
      expect(startEvent?.name).toBe("my-task");
      expect(startEvent?.idempotencyKey).toBe("idem-456");
      expect(startEvent?.userId).toBe("user-789");
      expect(startEvent?.taskType).toBe("background");
    });

    it("should persist error events on failure", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        throw new ValidationError("Something went wrong");
      });

      await executor.execute(task, definition);

      const calls = vi.mocked(mockEventLog.appendEvent).mock.calls;
      const eventTypes = calls.map((call) => call[0].type);

      expect(eventTypes).toContain("start");
      expect(eventTypes).toContain("error");
      expect(eventTypes).toContain("complete");

      const errorEvent = calls.find((call) => call[0].type === "error")?.[0];
      expect(errorEvent?.message).toContain("Something went wrong");
    });

    it("should persist retry events", async () => {
      const task = createMockTask();
      let attempts = 0;

      const definition = createMockDefinition(async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error("timeout");
        }
        return { result: "Success" };
      });

      await executor.execute(task, definition);

      const calls = vi.mocked(mockEventLog.appendEvent).mock.calls;
      const eventTypes = calls.map((call) => call[0].type);

      expect(eventTypes).toContain("retry");
    });

    it("should persist heartbeat events", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      const calls = vi.mocked(mockEventLog.appendEvent).mock.calls;
      const heartbeatEvents = calls.filter(
        (call) => call[0].type === "heartbeat",
      );

      expect(heartbeatEvents.length).toBeGreaterThanOrEqual(1);
    }, 10000);
  });

  describe("getStats", () => {
    it("should return correct statistics", async () => {
      const task = createMockTask();
      const definition = createMockDefinition(async () => {
        return { result: "Done" };
      });

      await executor.execute(task, definition);

      const stats = executor.getStats();

      expect(stats.outcomes.completed).toBe(1);
      expect(stats.outcomes.total).toBe(1);
      expect(stats.timing.lastStartAt).toBeDefined();
      expect(stats.timing.lastCompleteAt).toBeDefined();
    });
  });
});

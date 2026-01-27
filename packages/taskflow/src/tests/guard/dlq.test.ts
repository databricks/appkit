import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idempotencyKey, taskName, userId } from "@/core/branded";
import { Task } from "@/domain";
import { DeadLetterQueue } from "@/guard/dlq";
import type { DLQConfig, DLQEvent } from "@/guard/types";
import { noopHooks, type TaskSystemHooks } from "@/observability";

const createTask = (overrides?: Partial<Task>): Task =>
  new Task({
    name: taskName(overrides?.name ?? "test-task"),
    input: { data: "test" },
    userId: userId(overrides?.userId ?? "test-user"),
    idempotencyKey: idempotencyKey(
      overrides?.idempotencyKey ?? "test-idempotency-key",
    ),
  });

const createFailedTask = (overrides?: Partial<Task>): Task => {
  const task = createTask(overrides);
  task.start();
  task.fail(new Error("test error"));

  return task;
};

const defaultConfig: DLQConfig = {
  maxSize: 100,
  ttlMs: 24 * 60 * 60 * 1000,
  cleanupIntervalMs: 60_000,
  maxRetries: 3,
};

describe("DeadLetterQueue", () => {
  let dlq: DeadLetterQueue;

  beforeEach(() => {
    dlq = new DeadLetterQueue(defaultConfig);
  });

  afterEach(() => {
    dlq.shutdown();
  });

  describe("add", () => {
    it("should add a task to the DLQ", () => {
      const task = createTask();

      dlq.add(task, "test reason");

      expect(dlq.has(task.idempotencyKey)).toBe(true);
      expect(dlq.size).toBe(1);
    });

    it("should store reason and error", () => {
      const task = createTask();

      dlq.add(task, "test reason", "Error message");

      const entry = dlq.get(task.idempotencyKey);
      expect(entry?.reason).toBe("test reason");
      expect(entry?.error).toBe("Error message");
    });

    it("should set addedAt timestamp", () => {
      const task = createTask();
      const before = Date.now();

      dlq.add(task);

      const entry = dlq.get(task.idempotencyKey);
      expect(entry?.addedAt).toBeGreaterThanOrEqual(before);
      expect(entry?.addedAt).toBeLessThanOrEqual(Date.now());
    });
    it("should initialize retryCount to 0", () => {
      const task = createTask();

      dlq.add(task);

      const entry = dlq.get(task.idempotencyKey);
      expect(entry?.retryCount).toBe(0);
    });
  });

  describe("get", () => {
    it("should get DLQ entry with metadata", () => {
      const task = createTask();
      dlq.add(task, "test reason");

      const entry = dlq.get(task.idempotencyKey);

      expect(entry).toBeDefined();
      expect(entry?.task.id).toBe(task.id);
      expect(entry?.reason).toBe("test reason");
    });
    it("should return undefined for non-existent entry", () => {
      const entry = dlq.get(idempotencyKey("a".repeat(64)));

      expect(entry).toBeUndefined();
    });
  });

  describe("getAll", () => {
    it("should list all DLQ entries", () => {
      dlq.add(createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }));
      dlq.add(createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }));

      const entries = dlq.getAll();

      expect(entries).toHaveLength(2);
    });
  });

  describe("remove", () => {
    it("should remove task from DLQ", () => {
      const task = createTask();
      dlq.add(task);

      const removed = dlq.remove(task.idempotencyKey);

      expect(removed).toBe(true);
      expect(dlq.has(task.idempotencyKey)).toBe(false);
    });

    it("should return false when removing non-existent entry", () => {
      const removed = dlq.remove(idempotencyKey("a".repeat(64)));

      expect(removed).toBe(false);
    });
  });

  describe("eviction", () => {
    it("should evict oldest when DLQ is full", () => {
      const smallDlq = new DeadLetterQueue({ ...defaultConfig, maxSize: 2 });

      smallDlq.add(
        createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }),
      );
      smallDlq.add(
        createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }),
      );
      smallDlq.add(
        createTask({ idempotencyKey: idempotencyKey("c".repeat(64)) }),
      );

      expect(smallDlq.size).toBe(2);
      expect(smallDlq.has(idempotencyKey("a".repeat(64)))).toBe(false); // evicted
      expect(smallDlq.has(idempotencyKey("b".repeat(64)))).toBe(true);
      expect(smallDlq.has(idempotencyKey("c".repeat(64)))).toBe(true);

      smallDlq.shutdown();
    });
  });

  describe("TTL expiration", () => {
    it("should cleanup expired entries based on TTL", () => {
      vi.useFakeTimers();

      const shortTtlDlq = new DeadLetterQueue({
        ...defaultConfig,
        ttlMs: 100,
        cleanupIntervalMs: 50,
      });

      shortTtlDlq.add(createTask());
      expect(shortTtlDlq.size).toBe(1);

      // Advance time past TTL and cleanup interval
      vi.advanceTimersByTime(150);

      expect(shortTtlDlq.size).toBe(0);

      shortTtlDlq.shutdown();
      vi.useRealTimers();
    });
  });

  describe("retry", () => {
    it("should retry a task from DLQ", () => {
      const task = createFailedTask();
      dlq.add(task, "test failure");

      const retriedTask = dlq.retry(task.idempotencyKey);

      expect(retriedTask).not.toBeNull();
      expect(retriedTask?.status).toBe("created"); // resetToPending
      expect(dlq.has(task.idempotencyKey)).toBe(false);
    });

    it("should return null when retrying non-existent entry", () => {
      const result = dlq.retry(idempotencyKey("a".repeat(64)));

      expect(result).toBeNull();
    });

    it("should track retry count", () => {
      const task = createFailedTask();
      dlq.add(task, "test failure");

      // Entry starts with retryCount 0
      const entryBefore = dlq.get(task.idempotencyKey);
      expect(entryBefore?.retryCount).toBe(0);

      // Retry
      dlq.retry(task.idempotencyKey);

      // Stats should show 1 retry
      expect(dlq.getStats().totalRetries).toBe(1);
    });

    it("should respect max retries limit", () => {
      const limitedDlq = new DeadLetterQueue({
        ...defaultConfig,
        maxRetries: 0,
      });

      const task = createFailedTask();
      limitedDlq.add(task, "test failure");

      const result = limitedDlq.retry(task.idempotencyKey);

      expect(result).toBeNull();
      expect(limitedDlq.has(task.idempotencyKey)).toBe(true); // Still in DLQ

      limitedDlq.shutdown();
    });

    it("should retry all tasks from DLQ", () => {
      const task1 = createFailedTask({
        idempotencyKey: idempotencyKey("a".repeat(64)),
      });
      const task2 = createFailedTask({
        idempotencyKey: idempotencyKey("b".repeat(64)),
      });

      dlq.add(task1);
      dlq.add(task2);

      const retriedTasks = dlq.retryAll();

      expect(retriedTasks).toHaveLength(2);
      expect(dlq.size).toBe(0);
    });

    it("should retry DLQ entries with filter", () => {
      const task1 = createFailedTask({
        idempotencyKey: idempotencyKey("a".repeat(64)),
        name: taskName("task-a"),
      });
      const task2 = createFailedTask({
        idempotencyKey: idempotencyKey("b".repeat(64)),
        name: taskName("task-b"),
      });

      dlq.add(task1);
      dlq.add(task2);

      const retriedTasks = dlq.retryWithFilter(
        (entry) => entry.task.name === taskName("task-a"),
      );

      expect(retriedTasks).toHaveLength(1);
      expect(retriedTasks[0].name).toBe(taskName("task-a"));
      expect(dlq.size).toBe(1);
      expect(dlq.has(idempotencyKey("b".repeat(64)))).toBe(true);
    });
  });

  describe("events", () => {
    it("should emit dlq:added event", () => {
      const events: DLQEvent[] = [];
      dlq.onEvent((event) => events.push(event));

      dlq.add(createTask(), "test reason");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("dlq:added");
      expect(events[0].reason).toBe("test reason");
    });

    it("should emit dlq:removed event", () => {
      const task = createTask();
      dlq.add(task);

      const events: DLQEvent[] = [];
      dlq.onEvent((event) => events.push(event));

      dlq.remove(task.idempotencyKey);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("dlq:removed");
    });

    it("should emit dlq:retried event", () => {
      const task = createFailedTask();
      dlq.add(task);

      const events: DLQEvent[] = [];
      dlq.onEvent((event) => events.push(event));

      dlq.retry(task.idempotencyKey);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("dlq:retried");
    });

    it("should emit dlq:retry_exhausted event when max retries reached", () => {
      const limitedDlq = new DeadLetterQueue({
        ...defaultConfig,
        maxRetries: 0,
      });

      const task = createFailedTask();
      limitedDlq.add(task);

      const events: DLQEvent[] = [];
      limitedDlq.onEvent((event) => events.push(event));

      limitedDlq.retry(task.idempotencyKey);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("dlq:retry_exhausted");

      limitedDlq.shutdown();
    });

    it("should emit dlq:expired event", () => {
      vi.useFakeTimers();

      const shortTtlDlq = new DeadLetterQueue({
        ...defaultConfig,
        ttlMs: 100,
        cleanupIntervalMs: 50,
      });

      const events: DLQEvent[] = [];
      shortTtlDlq.onEvent((event) => events.push(event));

      shortTtlDlq.add(createTask());

      expect(events).toHaveLength(1); // dlq:added

      vi.advanceTimersByTime(150);

      expect(events).toHaveLength(2);
      expect(events[1].type).toBe("dlq:expired");

      shortTtlDlq.shutdown();
      vi.useRealTimers();
    });

    it("should emit dlq:evicted event when entry is evicted for capacity", () => {
      const smallDlq = new DeadLetterQueue({ ...defaultConfig, maxSize: 1 });

      const events: DLQEvent[] = [];
      smallDlq.onEvent((event) => events.push(event));

      smallDlq.add(
        createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }),
      );
      smallDlq.add(
        createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }),
      );

      // dlq:added, dlq:evicted, dlq:added
      expect(events).toHaveLength(3);
      expect(events[1].type).toBe("dlq:evicted");

      smallDlq.shutdown();
    });
    it("should allow unsubscribing from events", () => {
      const events: DLQEvent[] = [];
      const unsubscribe = dlq.onEvent((event) => events.push(event));

      dlq.add(createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }));
      expect(events).toHaveLength(1);

      unsubscribe();

      dlq.add(createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }));
      expect(events).toHaveLength(1); // Still 1, no new events
    });
  });

  describe("getStats", () => {
    it("should return DLQ statistics", () => {
      dlq.add(
        createTask({
          idempotencyKey: idempotencyKey("a".repeat(64)),
          name: taskName("task-a"),
        }),
        "timeout",
      );
      dlq.add(
        createTask({
          idempotencyKey: idempotencyKey("b".repeat(64)),
          name: taskName("task-a"),
        }),
        "timeout",
      );
      dlq.add(
        createTask({
          idempotencyKey: idempotencyKey("c".repeat(64)),
          name: taskName("task-b"),
        }),
        "error",
      );

      const stats = dlq.getStats();

      expect(stats.size).toBe(3);
      expect(stats.totalAdded).toBe(3);
    });
    it("should calculate average time in DLQ", () => {
      vi.useFakeTimers();

      dlq.add(createTask());

      vi.advanceTimersByTime(1000);

      const stats = dlq.getStats();
      expect(stats.avgAgeMs).toBeGreaterThanOrEqual(1000);

      vi.useRealTimers();
    });
    it("should track oldest entry age", () => {
      vi.useFakeTimers();

      dlq.add(createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }));
      vi.advanceTimersByTime(500);
      dlq.add(createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }));
      vi.advanceTimersByTime(500);

      const stats = dlq.getStats();
      expect(stats.oldestAgeMs).toBeGreaterThanOrEqual(1000);
      vi.useRealTimers();
    });
  });

  describe("clear", () => {
    it("should clear all entries and reset stats", () => {
      const task = createFailedTask();
      dlq.add(task);
      dlq.retry(task.idempotencyKey);

      // re-add for stats
      const task2 = createTask();
      dlq.add(task2);

      dlq.clear();

      expect(dlq.size).toBe(0);
      expect(dlq.getStats().totalRetries).toBe(0);
      expect(dlq.getStats().totalAdded).toBe(0);
    });
  });

  describe("shutdown", () => {
    it("shoudl clear entries and stop cleanup timer", () => {
      dlq.add(createTask());
      dlq.shutdown();

      expect(dlq.size).toBe(0);
    });
  });

  describe("observability hooks", () => {
    it("should record gauge for DLQ size", () => {
      const mockHooks: TaskSystemHooks = {
        ...noopHooks,
        recordGauge: vi.fn(),
      };
      const observedDLQ = new DeadLetterQueue(defaultConfig, mockHooks);
      observedDLQ.add(createTask());

      expect(mockHooks.recordGauge).toHaveBeenCalled();

      observedDLQ.shutdown();
    });

    it("should increment counter on add", () => {
      const mockHooks: TaskSystemHooks = {
        ...noopHooks,
        incrementCounter: vi.fn(),
      };
      const observedDLQ = new DeadLetterQueue(defaultConfig, mockHooks);
      observedDLQ.add(createTask());

      expect(mockHooks.incrementCounter).toHaveBeenCalled();

      observedDLQ.shutdown();
    });
  });
});

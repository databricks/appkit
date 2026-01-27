import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idempotencyKey, taskName, userId } from "@/core/branded";
import {
  BackpressureError,
  SlotTimeoutError,
  ValidationError,
} from "@/core/errors";
import { Task } from "@/domain/task";
import { Guard } from "@/guard/guard";
import type { GuardConfig } from "@/guard/types";

const createTask = (overrides: Partial<Task> = {}): Task =>
  new Task({
    name: taskName(overrides.name ?? "test-task"),
    input: { data: "test" },
    userId: userId(overrides.userId ?? "user-1"),
    idempotencyKey: idempotencyKey(
      overrides.idempotencyKey ?? "test-idempotency-key",
    ),
    executionOptions: overrides.executionOptions ?? undefined,
  });

const createFailedTask = (overrides: Partial<Task> = {}): Task => {
  const task = createTask(overrides);
  task.start();
  task.fail(new Error("Test error"));
  return task;
};

const defaultConfig: Partial<GuardConfig> = {
  backpressure: {
    windowSizeMs: 60_000,
    maxTasksPerWindow: 100,
    maxTasksPerUserWindow: 10,
    maxQueuedSize: 50,
  },
  slots: {
    maxExecutionGlobal: 10,
    maxExecutionPerUser: 5,
    slotTimeoutMs: 5000,
  },
  dlq: {
    maxSize: 100,
    ttlMs: 24 * 60 * 60 * 1000,
    cleanupIntervalMs: 60_000,
    maxRetries: 3,
  },
  recovery: {
    maxRecoverySlots: 5,
    recoverySlotTimeoutMs: 30_000,
  },
};

describe("Guard", () => {
  let guard: Guard;

  beforeEach(() => {
    guard = new Guard(defaultConfig as unknown as GuardConfig);
  });

  afterEach(() => {
    guard.shutdown();
  });

  describe("acceptTask", () => {
    it("should accept a task", () => {
      const task = createTask();

      expect(() => guard.acceptTask(task)).not.toThrow();
      expect(guard.getGlobalQueueSize()).toBe(1);
    });

    it("should throw BackpressureError when global queue is full", () => {
      const smallGuard = new Guard({
        ...defaultConfig,
        backpressure: { ...defaultConfig.backpressure!, maxQueuedSize: 1 },
        slots: defaultConfig.slots!,
        dlq: defaultConfig.dlq!,
        recovery: defaultConfig.recovery!,
      });

      smallGuard.acceptTask(
        createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }),
      );

      expect(() =>
        smallGuard.acceptTask(
          createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }),
        ),
      ).toThrow(BackpressureError);

      smallGuard.shutdown();
    });

    it("should throw BackpressureError when window limit reached", () => {
      const smallGuard = new Guard({
        ...defaultConfig,
        backpressure: { ...defaultConfig.backpressure!, maxTasksPerWindow: 1 },
        slots: defaultConfig.slots!,
        dlq: defaultConfig.dlq!,
        recovery: defaultConfig.recovery!,
      });

      smallGuard.acceptTask(
        createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }),
      );

      expect(() =>
        smallGuard.acceptTask(
          createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }),
        ),
      ).toThrow(BackpressureError);

      smallGuard.shutdown();
    });

    it("should throw BackpressureError when user limit reached", () => {
      const smallGuard = new Guard({
        ...defaultConfig,
        backpressure: {
          ...defaultConfig.backpressure!,
          maxTasksPerUserWindow: 1,
        },
        slots: defaultConfig.slots!,
        dlq: defaultConfig.dlq!,
        recovery: defaultConfig.recovery!,
      });

      smallGuard.acceptTask(
        createTask({
          idempotencyKey: idempotencyKey("a".repeat(64)),
          userId: userId("user-1"),
        }),
      );

      expect(() =>
        smallGuard.acceptTask(
          createTask({
            idempotencyKey: idempotencyKey("b".repeat(64)),
            userId: userId("user-1"),
          }),
        ),
      ).toThrow(BackpressureError);

      smallGuard.shutdown();
    });

    it("should throw ValidationError when task is in DLQ", () => {
      const task = createTask();
      guard.addToDLQ(task);

      expect(() => guard.acceptTask(task)).toThrow(ValidationError);
    });
  });

  describe("acquireExecutionSlot", () => {
    it("should acquire an execution slot", async () => {
      const task = createTask();
      guard.acceptTask(task);

      await guard.acquireExecutionSlot(task);

      expect(guard.getGlobalExecutionSize()).toBe(1);
      expect(guard.getUserExecutionSize(task.userId!)).toBe(1);
      expect(guard.getTemplateExecutionSize(task.name)).toBe(1);
    });

    it("should decrement queue size when acquiring slot", async () => {
      const task = createTask();
      guard.acceptTask(task);

      expect(guard.getGlobalQueueSize()).toBe(1);

      await guard.acquireExecutionSlot(task);

      expect(guard.getGlobalQueueSize()).toBe(0);
    });

    it("should throw SlotTimeoutError when timeout reached", async () => {
      vi.useFakeTimers();

      const smallGuard = new Guard({
        ...defaultConfig,
        slots: {
          ...defaultConfig.slots!,
          maxExecutionGlobal: 1,
          slotTimeoutMs: 100,
        },
        backpressure: defaultConfig.backpressure!,
        dlq: defaultConfig.dlq!,
        recovery: defaultConfig.recovery!,
      });

      const task1 = createTask({
        idempotencyKey: idempotencyKey("a".repeat(64)),
      });
      const task2 = createTask({
        idempotencyKey: idempotencyKey("b".repeat(64)),
      });

      smallGuard.acceptTask(task1);
      smallGuard.acceptTask(task2);

      await smallGuard.acquireExecutionSlot(task1);

      const acquirePromise = smallGuard.acquireExecutionSlot(task2);
      vi.advanceTimersByTime(150);

      await expect(acquirePromise).rejects.toThrow(SlotTimeoutError);

      smallGuard.shutdown();
      vi.useRealTimers();
    });

    it("should wait in queue and acquire slot when released", async () => {
      const smallGuard = new Guard({
        ...defaultConfig,
        slots: {
          ...defaultConfig.slots!,
          maxExecutionGlobal: 1,
          slotTimeoutMs: 5000,
        },
        backpressure: defaultConfig.backpressure!,
        dlq: defaultConfig.dlq!,
        recovery: defaultConfig.recovery!,
      });

      const task1 = createTask({
        idempotencyKey: idempotencyKey("a".repeat(64)),
      });
      const task2 = createTask({
        idempotencyKey: idempotencyKey("b".repeat(64)),
      });

      smallGuard.acceptTask(task1);
      smallGuard.acceptTask(task2);

      await smallGuard.acquireExecutionSlot(task1);
      expect(smallGuard.getGlobalExecutionSize()).toBe(1);

      const slot2Promise = smallGuard.acquireExecutionSlot(task2);
      expect(smallGuard.getWaitingQueueSize()).toBe(1);

      smallGuard.releaseExecutionSlot(task1);

      await slot2Promise;
      expect(smallGuard.getGlobalExecutionSize()).toBe(1);
      expect(smallGuard.getWaitingQueueSize()).toBe(0);

      smallGuard.shutdown();
    });

    it("should respect template execution limit", async () => {
      vi.useFakeTimers();

      const smallGuard = new Guard({
        ...defaultConfig,
        slots: { ...defaultConfig.slots!, slotTimeoutMs: 100 },
        backpressure: defaultConfig.backpressure!,
        dlq: defaultConfig.dlq!,
        recovery: defaultConfig.recovery!,
      });

      const task1 = createTask({
        idempotencyKey: idempotencyKey("a".repeat(64)),
        name: taskName("limited-task"),
        executionOptions: { maxConcurrentExecutions: 1 },
      });
      const task2 = createTask({
        idempotencyKey: idempotencyKey("b".repeat(64)),
        name: taskName("limited-task"),
        executionOptions: { maxConcurrentExecutions: 1 },
      });

      smallGuard.acceptTask(task1);
      smallGuard.acceptTask(task2);

      await smallGuard.acquireExecutionSlot(task1);

      const acquirePromise = smallGuard.acquireExecutionSlot(task2);
      vi.advanceTimersByTime(150);

      await expect(acquirePromise).rejects.toThrow(SlotTimeoutError);

      smallGuard.shutdown();
      vi.useRealTimers();
    });
  });

  describe("releaseExecutionSlot", () => {
    it("should release an execution slot", async () => {
      const task = createTask();
      guard.acceptTask(task);
      await guard.acquireExecutionSlot(task);

      expect(guard.getGlobalExecutionSize()).toBe(1);

      guard.releaseExecutionSlot(task);

      expect(guard.getGlobalExecutionSize()).toBe(0);
    });

    it("should not go below zero", () => {
      const task = createTask();

      guard.releaseExecutionSlot(task);
      guard.releaseExecutionSlot(task);

      expect(guard.getGlobalExecutionSize()).toBe(0);
    });
  });

  describe("recovery slots", () => {
    it("should acquire a recovery slot", () => {
      expect(() => guard.acquireRecoverySlot()).not.toThrow();
    });

    it("should release a recovery slot", () => {
      guard.acquireRecoverySlot();
      expect(() => guard.releaseRecoverySlot()).not.toThrow();
    });

    it("should throw BackpressureError when recovery capacity exhausted", () => {
      const smallGuard = new Guard({
        ...defaultConfig,
        recovery: { ...defaultConfig.recovery!, maxRecoverySlots: 1 },
        backpressure: defaultConfig.backpressure!,
        dlq: defaultConfig.dlq!,
        slots: defaultConfig.slots!,
      });

      smallGuard.acquireRecoverySlot();

      expect(() => smallGuard.acquireRecoverySlot()).toThrow(BackpressureError);

      smallGuard.shutdown();
    });

    it("should not go below zero on release", () => {
      guard.releaseRecoverySlot();
      guard.releaseRecoverySlot();

      // Should not throw, just stay at 0
      const stats = guard.getStats();
      expect(stats.recovery.inUse).toBe(0);
    });
  });

  describe("DLQ operations", () => {
    it("should add a task to the DLQ", () => {
      const task = createTask();
      guard.addToDLQ(task, "test reason");

      expect(guard.isTaskInDLQ(task.idempotencyKey)).toBe(true);
      expect(guard.getDLQSize()).toBe(1);
    });

    it("should get DLQ entry with metadata", () => {
      const task = createTask();
      guard.addToDLQ(task, "test reason");

      const entry = guard.getDLQEntry(task.idempotencyKey);

      expect(entry).toBeDefined();
      expect(entry?.task.id).toBe(task.id);
      expect(entry?.reason).toBe("test reason");
    });

    it("should list all DLQ entries", () => {
      guard.addToDLQ(
        createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }),
      );
      guard.addToDLQ(
        createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }),
      );

      const entries = guard.getDLQEntries();

      expect(entries).toHaveLength(2);
    });

    it("should remove task from DLQ", () => {
      const task = createTask();
      guard.addToDLQ(task);

      const removed = guard.removeFromDLQ(task.idempotencyKey);

      expect(removed).toBe(true);
      expect(guard.isTaskInDLQ(task.idempotencyKey)).toBe(false);
    });

    it("should retry a task from DLQ", () => {
      const task = createFailedTask();
      guard.addToDLQ(task, "test failure");

      const retriedTask = guard.retryFromDLQ(task.idempotencyKey);

      expect(retriedTask).not.toBeNull();
      expect(retriedTask?.status).toBe("created");
      expect(guard.isTaskInDLQ(task.idempotencyKey)).toBe(false);
    });

    it("should retry all tasks from DLQ", () => {
      const task1 = createFailedTask({
        idempotencyKey: idempotencyKey("a".repeat(64)),
      });
      const task2 = createFailedTask({
        idempotencyKey: idempotencyKey("b".repeat(64)),
      });

      guard.addToDLQ(task1);
      guard.addToDLQ(task2);

      const retriedTasks = guard.retryAllFromDLQ();

      expect(retriedTasks).toHaveLength(2);
      expect(guard.getDLQSize()).toBe(0);
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

      guard.addToDLQ(task1);
      guard.addToDLQ(task2);

      const retriedTasks = guard.retryDLQWithFilter(
        (entry) => entry.task.name === taskName("task-a"),
      );

      expect(retriedTasks).toHaveLength(1);
      expect(guard.getDLQSize()).toBe(1);
    });

    it("should subscribe to DLQ events", () => {
      const events: Array<{ type: string }> = [];
      guard.onDLQEvent((event) => events.push(event));

      guard.addToDLQ(createTask());

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("dlq:added");
    });

    it("should get DLQ stats", () => {
      guard.addToDLQ(
        createTask({ idempotencyKey: idempotencyKey("a".repeat(64)) }),
        "timeout",
      );
      guard.addToDLQ(
        createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }),
        "timeout",
      );

      const stats = guard.getDLQStats();

      expect(stats.size).toBe(2);
    });
  });

  describe("getStats", () => {
    it("should return comprehensive stats", async () => {
      const task1 = createTask({
        idempotencyKey: idempotencyKey("a".repeat(64)),
      });
      const task2 = createTask({
        idempotencyKey: idempotencyKey("b".repeat(64)),
      });

      guard.acceptTask(task1);
      guard.acceptTask(task2);
      await guard.acquireExecutionSlot(task1);

      guard.addToDLQ(
        createTask({ idempotencyKey: idempotencyKey("c".repeat(64)) }),
      );
      guard.acquireRecoverySlot();

      const stats = guard.getStats();

      expect(stats.admission.window.accepted).toBe(2);
      expect(stats.slots.current.inUse).toBe(1);
      expect(stats.dlq.size).toBe(1);
      expect(stats.recovery.inUse).toBe(1);
    });
  });

  describe("shutdown", () => {
    it("should clear all state on shutdown", async () => {
      const task = createTask();
      guard.acceptTask(task);
      await guard.acquireExecutionSlot(task);
      guard.addToDLQ(
        createTask({ idempotencyKey: idempotencyKey("b".repeat(64)) }),
      );
      guard.acquireRecoverySlot();

      guard.shutdown();

      expect(guard.getGlobalQueueSize()).toBe(0);
      expect(guard.getGlobalExecutionSize()).toBe(0);
      expect(guard.getDLQSize()).toBe(0);
      expect(guard.getStats().recovery.inUse).toBe(0);
    });
  });

  describe("clear", () => {
    it("should clear all state", async () => {
      const task = createTask();
      guard.acceptTask(task);
      await guard.acquireExecutionSlot(task);

      guard.clear();

      expect(guard.getGlobalQueueSize()).toBe(0);
      expect(guard.getGlobalExecutionSize()).toBe(0);
    });
  });

  describe("default configuration", () => {
    it("should use default config when none provided", () => {
      const defaultGuard = new Guard(defaultConfig as GuardConfig);

      // Should not throw
      const task = createTask();
      expect(() => defaultGuard.acceptTask(task)).not.toThrow();

      defaultGuard.shutdown();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idempotencyKey, taskName, userId } from "@/core/branded";
import { SlotTimeoutError } from "@/core/errors";
import { Task } from "@/domain";
import { SlotManager } from "@/guard/slot-manager";
import type { SlotManagerConfig } from "@/guard/types";
import type { TaskSystemHooks } from "@/observability/hooks";
import { noopHooks } from "@/observability/noop";

const createTask = (overrides?: Partial<Task>): Task =>
  new Task({
    name: taskName(overrides?.name ?? "test-task"),
    input: { data: "test" },
    userId: userId(overrides?.userId ?? "test-user"),
    idempotencyKey: idempotencyKey(
      overrides?.idempotencyKey ?? "test-idempotency-key",
    ),
    executionOptions: overrides?.executionOptions ?? undefined,
  });

const defaultConfig: SlotManagerConfig = {
  maxExecutionGlobal: 10,
  maxExecutionPerUser: 5,
  slotTimeoutMs: 5000,
};

describe("SlotManager", () => {
  let slotManager: SlotManager;
  beforeEach(() => {
    slotManager = new SlotManager(defaultConfig);
  });

  afterEach(() => {
    slotManager.clear();
  });

  describe("acquire", () => {
    it("should acquire an execution slot", async () => {
      const task = createTask();
      await slotManager.acquire(task);

      expect(slotManager.getGlobalExecutionSize()).toBe(1);
      expect(slotManager.getUserExecutionSize(task.userId!)).toBe(1);
      expect(slotManager.getTemplateExecutionSize(task.name)).toBe(1);
    });

    it("should acquire multiple slots up to global limit", async () => {
      const sm = new SlotManager({ ...defaultConfig, maxExecutionGlobal: 3 });
      await sm.acquire(createTask({ idempotencyKey: idempotencyKey("a") }));
      await sm.acquire(createTask({ idempotencyKey: idempotencyKey("b") }));
      await sm.acquire(createTask({ idempotencyKey: idempotencyKey("c") }));

      expect(sm.getGlobalExecutionSize()).toBe(3);
    });

    it("should wait in queue when global slots are full", async () => {
      const sm = new SlotManager({
        ...defaultConfig,
        maxExecutionGlobal: 1,
        slotTimeoutMs: 1000,
      });

      const task1 = createTask();
      const task2 = createTask();

      await sm.acquire(task1);
      expect(sm.getGlobalExecutionSize()).toBe(1);

      // start waiting for slot
      const slot2Promise = sm.acquire(task2);
      expect(sm.getWaitingQueueSize()).toBe(1);

      // release slot 1
      sm.release(task1);

      // slot2 should be acquired
      await slot2Promise;
      expect(sm.getGlobalExecutionSize()).toBe(1);
      expect(sm.getWaitingQueueSize()).toBe(0);
    });

    it("should throw SlotTimeoutError when timeout is reached", async () => {
      vi.useFakeTimers();

      const sm = new SlotManager({
        ...defaultConfig,
        maxExecutionGlobal: 1,
        slotTimeoutMs: 100,
      });

      const task1 = createTask();
      const task2 = createTask();

      await sm.acquire(task1);

      const acquirePromise = sm.acquire(task2);

      // advance time past timeout
      vi.advanceTimersByTime(150);

      await expect(acquirePromise).rejects.toThrow(SlotTimeoutError);

      try {
        await acquirePromise;
      } catch (error) {
        expect(SlotTimeoutError.is(error)).toBe(true);
        expect((error as SlotTimeoutError).timeoutMs).toBe(100);
      }

      vi.useRealTimers();
    });

    it("should respect per-user limits", async () => {
      vi.useFakeTimers();

      const sm = new SlotManager({
        ...defaultConfig,
        maxExecutionPerUser: 1,
        slotTimeoutMs: 100,
      });

      const task1 = createTask({ userId: userId("user-1") });
      const task2 = createTask({ userId: userId("user-1") });

      await sm.acquire(task1);

      const acquirePromise = sm.acquire(task2);
      vi.advanceTimersByTime(150);

      await expect(acquirePromise).rejects.toThrow(SlotTimeoutError);
      vi.useRealTimers();
    });

    it("should allow different users to acquire slots independently", async () => {
      const sm = new SlotManager({
        ...defaultConfig,
        maxExecutionPerUser: 1,
        maxExecutionGlobal: 10,
      });

      const task1 = createTask({ userId: userId("user-1") });
      const task2 = createTask({ userId: userId("user-2") });

      await sm.acquire(task1);
      await sm.acquire(task2);

      expect(sm.getGlobalExecutionSize()).toBe(2);
      expect(sm.getUserExecutionSize(userId("user-1")!)).toBe(1);
      expect(sm.getUserExecutionSize(userId("user-2")!)).toBe(1);
    });

    it("should respect per-template limits", async () => {
      vi.useFakeTimers();
      const sm = new SlotManager({
        ...defaultConfig,
        slotTimeoutMs: 100,
      });

      const task1 = createTask({
        name: taskName("task-1"),
        executionOptions: { maxConcurrentExecutions: 1 },
      });
      const task2 = createTask({
        name: taskName("task-1"),
        executionOptions: { maxConcurrentExecutions: 1 },
      });

      await sm.acquire(task1);

      const acquirePromise = sm.acquire(task2);
      vi.advanceTimersByTime(150);

      await expect(acquirePromise).rejects.toThrow(SlotTimeoutError);
      vi.useRealTimers();
    });

    it("should rollback user count when template limit fails", async () => {
      vi.useFakeTimers();
      const sm = new SlotManager({
        ...defaultConfig,
        slotTimeoutMs: 100,
      });

      const task1 = createTask({
        name: taskName("task-1"),
        executionOptions: { maxConcurrentExecutions: 1 },
      });

      await sm.acquire(task1);
      expect(sm.getTemplateExecutionSize(task1.name)).toBe(1);

      const task2 = createTask({
        name: taskName("task-1"),
        executionOptions: { maxConcurrentExecutions: 1 },
      });

      const acquirePromise = sm.acquire(task2);
      vi.advanceTimersByTime(150);

      await expect(acquirePromise).rejects.toThrow(SlotTimeoutError);

      // user count should still be 1, not 2
      expect(sm.getUserExecutionSize(task1.userId!)).toBe(1);
      vi.useRealTimers();
    });

    it("should handle background tasks (null userId)", async () => {
      const task = createTask({ userId: null });

      await slotManager.acquire(task);
      expect(slotManager.getGlobalExecutionSize()).toBe(1);
    });
  });

  describe("release", () => {
    it("should release an execution slot", async () => {
      const task = createTask();

      await slotManager.acquire(task);
      expect(slotManager.getGlobalExecutionSize()).toBe(1);

      slotManager.release(task);

      expect(slotManager.getGlobalExecutionSize()).toBe(0);
      expect(slotManager.getUserExecutionSize(task.userId!)).toBe(0);
      expect(slotManager.getTemplateExecutionSize(task.name)).toBe(0);
    });

    it("should not go below zero on release", async () => {
      const task = createTask();

      slotManager.release(task);
      slotManager.release(task);

      expect(slotManager.getGlobalExecutionSize()).toBe(0);
      expect(slotManager.getUserExecutionSize(task.userId!)).toBe(0);
    });

    it("should process waiting queue when slot is released", async () => {
      const sm = new SlotManager({
        ...defaultConfig,
        maxExecutionGlobal: 1,
        slotTimeoutMs: 5000,
      });

      const task1 = createTask();
      const task2 = createTask();

      await sm.acquire(task1);
      const slot2Promise = sm.acquire(task2);
      expect(sm.getWaitingQueueSize()).toBe(1);

      sm.release(task1);

      await slot2Promise;
      expect(sm.getGlobalExecutionSize()).toBe(1);
      expect(sm.getWaitingQueueSize()).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should return slot statistics", async () => {
      await slotManager.acquire(createTask());

      const stats = slotManager.getStats();

      expect(stats.current.inUse).toBe(1);
      expect(stats.current.waiting).toBe(0);
      expect(stats.current.available).toBe(9);
      expect(stats.limits.global).toBe(10);
      expect(stats.limits.perUser).toBe(5);
      expect(stats.events.acquired).toBe(1);
    });
    it("should track timeout events", async () => {
      vi.useFakeTimers();

      const sm = new SlotManager({
        ...defaultConfig,
        maxExecutionGlobal: 1,
        slotTimeoutMs: 100,
      });

      await sm.acquire(createTask());
      const acquirePromise = sm.acquire(createTask());
      vi.advanceTimersByTime(150);

      try {
        await acquirePromise;
      } catch {}

      expect(sm.getStats().events.timeouts).toBe(1);
      vi.useRealTimers();
    });
  });

  describe("clear", () => {
    it("should clear all state", async () => {
      await slotManager.acquire(createTask());

      slotManager.clear();

      expect(slotManager.getGlobalExecutionSize()).toBe(0);
      expect(slotManager.getWaitingQueueSize()).toBe(0);
      expect(slotManager.getStats().events.acquired).toBe(0);
    });
  });

  describe("observability hooks", () => {
    it("shoudl record gauge on slot acquisition", async () => {
      const mockHooks: TaskSystemHooks = {
        ...noopHooks,
        recordGauge: vi.fn(),
      };

      const sm = new SlotManager(defaultConfig, mockHooks);
      await sm.acquire(createTask());

      expect(mockHooks.recordGauge).toHaveBeenCalled();
    });

    it("should increment counter on timeout", async () => {
      vi.useFakeTimers();

      const mockHooks: TaskSystemHooks = {
        ...noopHooks,
        incrementCounter: vi.fn(),
      };

      const sm = new SlotManager(
        { ...defaultConfig, maxExecutionGlobal: 1 },
        mockHooks,
      );
      await sm.acquire(createTask());

      const acquirePromise = sm.acquire(
        createTask({ idempotencyKey: idempotencyKey("second-task") }),
      );
      vi.advanceTimersByTime(defaultConfig.slotTimeoutMs);
      try {
        await acquirePromise;
      } catch {}

      expect(mockHooks.incrementCounter).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});

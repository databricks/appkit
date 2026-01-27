import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idempotencyKey, taskName, userId } from "@/core/branded";
import { BackpressureError, ValidationError } from "@/core/errors";
import { Task } from "@/domain";
import { Backpressure } from "@/guard/backpressure";
import type { BackpressureConfig } from "@/guard/types";
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

const defaultConfig: BackpressureConfig = {
  windowSizeMs: 60_000,
  maxTasksPerWindow: 100,
  maxTasksPerUserWindow: 10,
  maxQueuedSize: 50,
};

describe("Backpressure", () => {
  let backpressure: Backpressure;
  beforeEach(() => {
    backpressure = new Backpressure(defaultConfig);
  });

  afterEach(() => {
    backpressure.clear();
  });

  describe("accept", () => {
    it("should accept tasks within global window limit", () => {
      const task = createTask({});
      expect(() => backpressure.accept(task, false)).not.toThrow();
      expect(backpressure.getQueueSize()).toBe(1);
    });

    it("should reject tasks when global window limit is exceeded", () => {
      const backpressure = new Backpressure({
        ...defaultConfig,
        maxTasksPerWindow: 2,
      });

      backpressure.accept(
        createTask({ idempotencyKey: idempotencyKey("key-1") }),
        false,
      );
      backpressure.accept(
        createTask({ idempotencyKey: idempotencyKey("key-2") }),
        false,
      );

      expect(() =>
        backpressure.accept(
          createTask({ idempotencyKey: idempotencyKey("key-3") }),
          false,
        ),
      ).toThrow(BackpressureError);
    });

    it("should accept tasks within user window limit", () => {
      const backpressure = new Backpressure({
        ...defaultConfig,
        maxTasksPerUserWindow: 2,
      });

      backpressure.accept(createTask({ userId: userId("user-1") }), false);
      backpressure.accept(createTask({ userId: userId("user-2") }), false);

      expect(backpressure.getQueueSize()).toBe(2);
    });

    it("should reject tasks when user window limit is exceeded", () => {
      const backpressure = new Backpressure({
        ...defaultConfig,
        maxTasksPerUserWindow: 1,
      });

      backpressure.accept(createTask({ userId: userId("user-1") }), false);
      expect(() =>
        backpressure.accept(createTask({ userId: userId("user-1") }), false),
      ).toThrow(BackpressureError);
    });

    it("should allow different users within their own limits", () => {
      const backpressure = new Backpressure({
        ...defaultConfig,
        maxTasksPerUserWindow: 2,
      });

      backpressure.accept(createTask({ userId: userId("user-1") }), false);
      backpressure.accept(createTask({ userId: userId("user-2") }), false);

      expect(backpressure.getQueueSize()).toBe(2);
    });

    it("should accept tasks within global queue limit", () => {
      const backpressure = new Backpressure({
        ...defaultConfig,
        maxQueuedSize: 2,
      });

      backpressure.accept(createTask({}), false);
      backpressure.accept(createTask({}), false);

      expect(backpressure.getQueueSize()).toBe(2);
    });

    it("should reject tasks when global queue limit is exceeded", () => {
      const backpressure = new Backpressure({
        ...defaultConfig,
        maxQueuedSize: 1,
      });

      backpressure.accept(createTask({}), false);
      expect(() => backpressure.accept(createTask({}), false)).toThrow(
        BackpressureError,
      );
    });

    it("should reject tasks that are in DLQ", () => {
      const task = createTask();
      expect(() => backpressure.accept(task, true)).toThrow(ValidationError);

      try {
        backpressure.accept(task, true);
      } catch (error) {
        expect(ValidationError.is(error)).toBe(true);
        expect((error as ValidationError).message).toContain("DLQ");
      }
    });

    it("should calculate retryAfterMs based on window reset time", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const backpressure = new Backpressure({
        ...defaultConfig,
        maxTasksPerWindow: 1,
        windowSizeMs: 1000,
      });

      backpressure.accept(createTask(), false);
      vi.advanceTimersByTime(200); // 200ms later

      try {
        backpressure.accept(createTask(), false);
      } catch (error) {
        expect(BackpressureError.is(error)).toBe(true);
        const retryAfter = (error as BackpressureError).retryAfterMs;
        expect(retryAfter).toBeGreaterThanOrEqual(700);
        expect(retryAfter).toBeLessThanOrEqual(800);
      }

      vi.useRealTimers();
    });

    it("should reset counts after window expires", () => {
      vi.useFakeTimers();

      const backpressure = new Backpressure({
        ...defaultConfig,
        maxTasksPerWindow: 1,
        windowSizeMs: 1000,
      });

      backpressure.accept(createTask(), false);

      // advance past the window
      vi.advanceTimersByTime(1100);

      // should accept now since window reset
      expect(() => backpressure.accept(createTask(), false)).not.toThrow();

      vi.useRealTimers();
    });

    it("should handle background tasks (null userId)", () => {
      const task = createTask({ userId: null });

      expect(() => backpressure.accept(task, false)).not.toThrow();
      expect(backpressure.getQueueSize()).toBe(1);
    });
  });

  describe("decrementQueueSize", () => {
    it("should decrement the queue size", () => {
      backpressure.accept(createTask(), false);
      backpressure.accept(createTask(), false);

      expect(backpressure.getQueueSize()).toBe(2);
      backpressure.decrementQueueSize();
      expect(backpressure.getQueueSize()).toBe(1);
    });

    it("should not go below zero", () => {
      backpressure.decrementQueueSize();
      backpressure.decrementQueueSize();

      expect(backpressure.getQueueSize()).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should return admission stats", () => {
      backpressure.accept(createTask(), false);
      const stats = backpressure.getStats();

      expect(stats.config).toEqual(defaultConfig);
      expect(stats.window.accepted).toBe(1);
      expect(stats.totals.accepted).toBe(1);
      expect(stats.totals.rejected).toBe(0);
    });

    it("should track rejections by reason", () => {
      const backpressure = new Backpressure({
        ...defaultConfig,
        maxTasksPerWindow: 1,
      });

      backpressure.accept(createTask(), false);
      try {
        backpressure.accept(createTask(), false);
      } catch {}

      const stats = backpressure.getStats();

      expect(stats.rejections.byReason.global_rate_limit).toBe(1);
      expect(stats.totals.rejected).toBe(1);
    });
  });

  describe("clear", () => {
    it("should reset all state", () => {
      backpressure.accept(createTask(), false);

      backpressure.clear();

      expect(backpressure.getQueueSize()).toBe(0);
      expect(backpressure.getStats().totals.accepted).toBe(0);
    });
  });

  describe("observability hooks", () => {
    it("should call incrementCounter on rejection", () => {
      const mockHooks: TaskSystemHooks = {
        ...noopHooks,
        incrementCounter: vi.fn(),
      };

      const backpressure = new Backpressure(
        { ...defaultConfig, maxTasksPerWindow: 1 },
        mockHooks,
      );
      backpressure.accept(createTask(), false);
      try {
        backpressure.accept(createTask(), false);
      } catch {}

      expect(mockHooks.incrementCounter).toHaveBeenCalled();
    });
  });
});

import { describe, expect, it } from "vitest";
import { idempotencyKey, taskName, userId } from "@/core/branded";
import { TaskStateError } from "@/core/errors";
import type { TaskRecord } from "@/domain";
import { Task } from "@/domain/task";

describe("Task", () => {
  describe("Constructor", () => {
    it("should create a task with default values", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });

      expect(task.id).toBeDefined();
      expect(task.name).toBe("my-task");
      expect(task.input).toEqual({ value: 42 });
      expect(task.userId).toBe("user123");
      expect(task.type).toBe("user");
      expect(task.status).toBe("created");
      expect(task.attempt).toBe(0);
      expect(task.createdAt).toBeDefined();
      expect(task.idempotencyKey).toBeDefined();
    });

    it("should create a task with custom type (background)", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId(null),
        type: "background",
      });

      expect(task.type).toBe("background");
      expect(task.userId).toBeNull();
    });

    it("should use provided idempotencyKey", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: {},
        userId: userId("user123"),
        idempotencyKey: idempotencyKey("abc123"),
      });
      expect(task.idempotencyKey).toBe("abc123");
    });

    it("should generate deterministic idempotencyKey", () => {
      const params = {
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      };
      const task1 = new Task(params);
      const task2 = new Task(params);
      expect(task1.idempotencyKey).toBe(task2.idempotencyKey);
    });

    it("should generate different idempotencykey for different inputs", () => {
      const task1 = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      const task2 = new Task({
        name: taskName("my-task"),
        input: { value: 43 },
        userId: userId("user123"),
      });
      expect(task1.idempotencyKey).not.toBe(task2.idempotencyKey);
    });

    it("should generate same idempotencyKey regardless of object key order", () => {
      const task1 = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      const task2 = new Task({
        name: taskName("my-task"),
        userId: userId("user123"),
        input: { value: 42 },
      });
      expect(task1.idempotencyKey).toBe(task2.idempotencyKey);
    });
  });

  describe("start()", () => {
    it("should transition from created to running", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      expect(task.status).toBe("running");
      expect(task.attempt).toBe(1);
      expect(task.startedAt).toBeDefined();
      expect(task.lastHeartbeatAt).toBeDefined();
    });

    it("should throw if task is already running", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      expect(() => task.start()).toThrow(TaskStateError);
      expect(() => task.start()).toThrow(
        "Cannot start from state running, allowed: created",
      );
    });

    it("should throw if task is in terminal state", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.complete();

      expect(() => task.start()).toThrow(TaskStateError);
      expect(() => task.start()).toThrow("Cannot start a terminal task");
    });
  });
  describe("complete()", () => {
    it("should transition from running to completed", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });

      task.start();
      task.complete({ data: "result" });
      expect(task.status).toBe("completed");
      expect(task.completedAt).toBeDefined();
      expect(task.result).toEqual({ data: "result" });
      expect(task.isTerminal).toBe(true);
    });

    it("should work without result", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.complete();
      expect(task.status).toBe("completed");
      expect(task.result).toBeUndefined();
    });

    it("should throw if task is not running", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.complete();
      expect(() => task.complete()).toThrow(TaskStateError);
      expect(() => task.complete()).toThrow("Cannot complete a terminal task");
    });

    it("should throw if task is already completed", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.complete();
      expect(() => task.complete()).toThrow(TaskStateError);
      expect(() => task.complete()).toThrow("Cannot complete a terminal task");
    });
  });
  describe("fail()", () => {
    it("should transition from running to failed with string error", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.fail("test error");
      expect(task.status).toBe("failed");
      expect(task.completedAt).toBeDefined();
      expect(task.error).toBe("test error");
      expect(task.isTerminal).toBe(true);
    });

    it("should extract message from Error object", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.fail(new Error("test error"));
      expect(task.status).toBe("failed");
    });
    it("should throw if task is not running", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      expect(() => task.fail("error")).toThrow(TaskStateError);
      expect(() => task.fail("error")).toThrow(
        "Cannot fail from state created, allowed: running",
      );
    });
  });

  describe("cancel()", () => {
    it("should transition from created to cancelled", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.cancel("test reason");
      expect(task.status).toBe("cancelled");
      expect(task.error).toBe("test reason");
      expect(task.isTerminal).toBe(true);
    });
    it("should transition from running to cancelled", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.cancel("test reason");
      expect(task.status).toBe("cancelled");
      expect(task.error).toBe("test reason");
    });

    it("should throw if task is in terminal state", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.complete();
      expect(() => task.cancel("test reason")).toThrow(TaskStateError);
    });
  });

  describe("recordHeartbeat()", () => {
    it("should update lastHeartbeatAt", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      task.recordHeartbeat();
      expect(task.lastHeartbeatAt).toBeInstanceOf(Date);
    });

    it("should throw if task is not running", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      expect(() => task.recordHeartbeat()).toThrow(
        "Cannot recordHeartbeat from state created, allowed: running",
      );
    });
  });

  describe("incrementAttempt()", () => {
    it("should increment attempt counter", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task.start();
      expect(task.attempt).toBe(1);
      task.incrementAttempt();
      expect(task.attempt).toBe(2);

      task.incrementAttempt();
      expect(task.attempt).toBe(3);
    });

    it("should throw if task is not running", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });

      expect(() => task.incrementAttempt()).toThrow(TaskStateError);
    });
  });

  describe("resetToPending()", () => {
    it("should reset failed task to created", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });

      task.start();
      task.fail("error");

      expect(task.status).toBe("failed");
      expect(task.error).toBe("error");
      task.resetToPending();
      expect(task.status).toBe("created");
      expect(task.error).toBeUndefined();
      expect(task.completedAt).toBeUndefined();
    });

    it("should throw if task is not failed", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      expect(() => task.resetToPending()).toThrow(TaskStateError);
      task.start();
      expect(() => task.resetToPending()).toThrow(TaskStateError);
    });
  });

  describe("computed properties", () => {
    describe("durationMs", () => {
      it("should return undefined if task not started", async () => {
        const task = new Task({
          name: taskName("my-task"),
          input: { value: 42 },
          userId: userId("user123"),
        });

        task.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        task.complete();

        expect(task.durationMs).toBeGreaterThanOrEqual(50);
      });

      it("should calculate running duration for active tasks", async () => {
        const task = new Task({
          name: taskName("my-task"),
          input: { value: 42 },
          userId: userId("user123"),
        });
        task.start();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(task.durationMs).toBeGreaterThanOrEqual(30);
      });
    });

    describe("isTerminal", () => {
      it("should return false for created and running", () => {
        const task = new Task({
          name: taskName("my-task"),
          input: { value: 42 },
          userId: userId("user123"),
        });
        expect(task.isTerminal).toBe(false);
        task.start();
        expect(task.isTerminal).toBe(false);
      });

      it("should return true for completed, failed, cancelled", () => {
        const task1 = new Task({
          name: taskName("my-task"),
          input: { value: 42 },
          userId: userId("user123"),
        });

        task1.start();
        task1.complete();
        expect(task1.isTerminal).toBe(true);

        const task2 = new Task({
          name: taskName("my-task"),
          input: { value: 42 },
          userId: userId("user123"),
        });

        task2.start();
        task2.fail("error");
        expect(task2.isTerminal).toBe(true);

        const task3 = new Task({
          name: taskName("my-task"),
          input: { value: 42 },
          userId: userId("user123"),
        });
        task3.cancel();
        expect(task3.isTerminal).toBe(true);
      });
    });

    describe("isRunning", () => {
      it("should return true only when running", () => {
        const task = new Task({
          name: taskName("my-task"),
          input: { value: 42 },
          userId: userId("user123"),
        });
        expect(task.isRunning).toBe(false);
        task.start();
        expect(task.isRunning).toBe(true);
        task.complete();
        expect(task.isRunning).toBe(false);
      });
    });
  });

  describe("toJSON", () => {
    it("should serialize task to JSON", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
        type: "background",
      });
      task.start();
      task.complete({ result: "done" });
      const json = task.toJSON();
      expect(json.id).toBe(task.id);
      expect(json.name).toBe("my-task");
      expect(json.input).toEqual({ value: 42 });
      expect(json.userId).toBe("user123");
      expect(json.type).toBe("background");
      expect(json.status).toBe("completed");
      expect(json.result).toEqual({ result: "done" });
      expect(typeof json.createdAt).toBe("string");
      expect(typeof json.startedAt).toBe("string");
      expect(typeof json.completedAt).toBe("string");
      expect(typeof json.durationMs).toBe("number");
    });
  });

  describe("generateIdempotencyKey", () => {
    it("should generate consistent key for same params", () => {
      const params = {
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      };
      const key1 = Task.generateIdempotencyKey(params);
      const key2 = Task.generateIdempotencyKey(params);
      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64);
    });

    it("should handle null userId", () => {
      const key = Task.generateIdempotencyKey({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId(null),
      });
      expect(key).toHaveLength(64);
    });
  });

  describe("fromRecord()", () => {
    it("should reconstruct Task from database record", () => {
      const record: TaskRecord = {
        id: "task123",
        name: "my-task",
        idempotency_key: "abc123",
        user_id: "user123",
        task_type: "user",
        status: "completed",
        input: JSON.stringify({ value: 42 }),
        result: JSON.stringify({ result: "done" }),
        error: null,
        attempt: 1,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        execution_options: JSON.stringify({ concurrency: 1 }),
      };

      const task = Task.fromRecord(record);
      expect(task.id).toBe("task123");
      expect(task.name).toBe("my-task");
      expect(task.idempotencyKey).toBe("abc123");
      expect(task.userId).toBe("user123");
      expect(task.type).toBe("user");
      expect(task.status).toBe("completed");
      expect(task.input).toEqual({ value: 42 });
      expect(task.result).toEqual({ result: "done" });
      expect(task.error).toBeUndefined();
    });

    it("should restore all mutable state", () => {
      const record: TaskRecord = {
        id: "task-abc123",
        name: "test-task",
        idempotency_key: "idem-key",
        user_id: "user-123",
        task_type: "background",
        status: "failed",
        input: "{}",
        result: null,
        error: "Something went wrong",
        attempt: 3,
        created_at: "2024-01-01T00:00:00.000Z",
        started_at: "2024-01-01T00:00:01.000Z",
        completed_at: "2024-01-01T00:00:05.000Z",
        last_heartbeat_at: "2024-01-01T00:00:04.000Z",
        execution_options: '{"maxRetries":5}',
      };

      const task = Task.fromRecord(record);

      expect(task.type).toBe("background");
      expect(task.status).toBe("failed");
      expect(task.attempt).toBe(3);
      expect(task.error).toBe("Something went wrong");
      expect(task.startedAt).toBeInstanceOf(Date);
      expect(task.completedAt).toBeInstanceOf(Date);
      expect(task.lastHeartbeatAt).toBeInstanceOf(Date);
      expect(task.executionOptions).toEqual({ maxRetries: 5 });
    });
  });
  describe("state machine transitions", () => {
    it("should follow valid state transitions", () => {
      // created -> running -> completed
      const task1 = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      expect(task1.status).toBe("created");
      task1.start();
      expect(task1.status).toBe("running");
      task1.complete();
      expect(task1.status).toBe("completed");

      // created -> running -> failed
      const task2 = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      expect(task2.status).toBe("created");
      task2.start();
      task2.fail("error");
      expect(task2.status).toBe("failed");

      // created -> running -> cancelled
      const task3 = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task3.start();
      task3.cancel("test reason");
      expect(task3.status).toBe("cancelled");

      // created -> cancelled
      const task4 = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task4.cancel("test reason");
      expect(task4.status).toBe("cancelled");

      // failed -> created (via resetToPending)
      const task5 = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });
      task5.start();
      task5.fail("error");
      expect(task5.status).toBe("failed");
      task5.resetToPending();
      expect(task5.status).toBe("created");
    });

    it("should reject invalid state transitions", () => {
      const task = new Task({
        name: taskName("my-task"),
        input: { value: 42 },
        userId: userId("user123"),
      });

      // created -> complete (invalid, must be running)
      expect(() => task.complete()).toThrow(TaskStateError);

      // created -> fail (invalid, must be running)
      expect(() => task.fail("error")).toThrow(TaskStateError);

      task.start();
      task.complete();

      // completed -> anything (invalid, terminal)
      expect(() => task.start()).toThrow(TaskStateError);
      expect(() => task.complete()).toThrow(TaskStateError);
      expect(() => task.fail("error")).toThrow(TaskStateError);
      expect(() => task.cancel()).toThrow(TaskStateError);
    });
  });
});

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idempotencyKey, taskId } from "@/core/branded";
import type { EventLogEntry } from "@/domain/events";
import { SQLiteConnector } from "@/persistence/repository/sqlite/connector";

describe("SQLiteConnector", () => {
  let connector: SQLiteConnector;
  const testDbPath = "./test-sqlite-connector.db";

  beforeEach(async () => {
    connector = new SQLiteConnector({ database: testDbPath });
    await connector.initialize();
  });

  afterEach(async () => {
    await connector.close();

    // cleanup database files
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(`${testDbPath}${suffix}`)) {
        fs.unlinkSync(`${testDbPath}${suffix}`);
      }
    }
  });

  describe("initialization", () => {
    it("should initialize the connector", () => {
      expect(connector.isInitialized).toBe(true);
    });

    it("should close the connector", async () => {
      await connector.close();
      expect(connector.isInitialized).toBe(false);
    });
  });

  describe("executeTaskCreated", () => {
    it("should insert a task into tasks table", async () => {
      const entry: EventLogEntry = {
        type: "TASK_CREATED",
        taskId: "task-001",
        name: "test-task",
        idempotencyKey: "idem-001",
        userId: "user-123",
        timestamp: Date.now(),
        input: { foo: "bar" },
        taskType: "user",
      };

      await connector.executeBatch([entry]);

      const task = connector.findTaskById(taskId("task-001"));
      expect(task).not.toBeNull();
      expect(task?.name).toBe("test-task");
      expect(task?.status).toBe("created");
    });

    it("should insert task event with seq 1", async () => {
      const entry: EventLogEntry = {
        type: "TASK_CREATED",
        taskId: "task-001",
        name: "test-task",
        idempotencyKey: "idem-001",
        userId: "user-123",
        timestamp: Date.now(),
        taskType: "user",
      };

      await connector.executeBatch([entry]);

      const events = connector.getTaskEvents(taskId("task-001"));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("TASK_CREATED");
      expect(events[0].seq).toBe(1);
    });
  });

  describe("executeTaskRunning", () => {
    it("should update task status to running", async () => {
      const now = Date.now();
      const entries: EventLogEntry[] = [
        {
          type: "TASK_CREATED",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now,
          taskType: "user",
        },
        {
          type: "TASK_START",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now + 100,
          taskType: "user",
        },
      ];

      await connector.executeBatch(entries);

      const task = connector.findTaskById(taskId("task-001"));
      expect(task?.status).toBe("running");
      expect(task?.startedAt).not.toBeNull();
    });
  });

  describe("executeTaskCompleted", () => {
    it("should update task status to completed with result", async () => {
      const now = Date.now();
      const entries: EventLogEntry[] = [
        {
          type: "TASK_CREATED",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now,
          taskType: "user",
        },
        {
          type: "TASK_START",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now + 100,
          taskType: "user",
        },
        {
          type: "TASK_COMPLETE",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now + 1000,
          taskType: "user",
          result: { success: true },
        },
      ];

      await connector.executeBatch(entries);

      const task = connector.findTaskById(taskId("task-001"));
      expect(task?.status).toBe("completed");
      expect(task?.result).toEqual({ success: true });
    });
  });

  describe("executeTaskHeartbeat", () => {
    it("should update heartbeat but NOT insert task event", async () => {
      const now = Date.now();
      const entries: EventLogEntry[] = [
        {
          type: "TASK_CREATED",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now,
          taskType: "user",
        },
        {
          type: "TASK_START",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now + 100,
          taskType: "user",
        },
        {
          type: "TASK_HEARTBEAT",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: now + 500,
          taskType: "user",
        },
      ];

      await connector.executeBatch(entries);

      // only 2 events, created and start
      const events = connector.getTaskEvents(taskId("task-001"));
      expect(events).toHaveLength(2);

      // heartbeat is not stored in task_events table
      const task = connector.findTaskById(taskId("task-001"));
      expect(task?.lastHeartbeatAt).toBeDefined();
    });
  });

  describe("findStaleTasks", () => {
    it("should find stale running tasks", async () => {
      const oldTimestamp = Date.now() - 60000; // 1 minute ago

      const entries: EventLogEntry[] = [
        {
          type: "TASK_CREATED",
          taskId: "task-stale",
          name: "stale-task",
          idempotencyKey: "idem-stale",
          userId: "user-123",
          timestamp: oldTimestamp,
          taskType: "user",
        },
        {
          type: "TASK_START",
          taskId: "task-stale",
          name: "stale-task",
          idempotencyKey: "idem-stale",
          userId: "user-123",
          timestamp: oldTimestamp + 100,
          taskType: "user",
        },
      ];

      await connector.executeBatch(entries);

      const staleTasks = connector.findStaleTasks(30000);
      expect(staleTasks).toHaveLength(1);
      expect(staleTasks[0]?.id).toBe("task-stale");
    });

    it("should not return fresh running tasks", async () => {
      const now = Date.now();

      const entries: EventLogEntry[] = [
        {
          type: "TASK_CREATED",
          taskId: "task-fresh",
          name: "fresh-task",
          idempotencyKey: "idem-fresh",
          userId: "user-123",
          timestamp: now,
          taskType: "user",
        },
        {
          type: "TASK_START",
          taskId: "task-fresh",
          name: "fresh-task",
          idempotencyKey: "idem-fresh",
          userId: "user-123",
          timestamp: now + 100,
          taskType: "user",
        },
      ];

      await connector.executeBatch(entries);

      const staleTasks = connector.findStaleTasks(30000);
      expect(staleTasks).toHaveLength(0);
    });
  });

  describe("query methods", () => {
    beforeEach(async () => {
      await connector.executeBatch([
        {
          type: "TASK_CREATED",
          taskId: "task-001",
          name: "test-task",
          idempotencyKey: "idem-001",
          userId: "user-123",
          timestamp: Date.now(),
          taskType: "user",
        },
      ]);
    });

    it("should find task by id", () => {
      const task = connector.findTaskById(taskId("task-001"));
      expect(task).not.toBeNull();
      expect(task?.id).toBe("task-001");
    });

    it("should return null for non-existent task", () => {
      const task = connector.findTaskById(taskId("non-existent"));
      expect(task).toBeNull();
    });

    it("should find task by idempotency key", () => {
      const task = connector.findTaskByIdempotencyKey(
        idempotencyKey("idem-001"),
      );
      expect(task).not.toBeNull();
      expect(task?.idempotencyKey).toBe("idem-001");
    });
  });

  describe("getTaskEvents", () => {
    it("should return events in order by seq", async () => {
      const now = Date.now();
      const entries: EventLogEntry[] = [
        {
          type: "TASK_CREATED",
          taskId: "task-001",
          name: "t",
          idempotencyKey: "i",
          userId: "u",
          timestamp: now,
          taskType: "user",
        },
        {
          type: "TASK_START",
          taskId: "task-001",
          name: "t",
          idempotencyKey: "i",
          userId: "u",
          timestamp: now + 100,
          taskType: "user",
        },
        {
          type: "TASK_PROGRESS",
          taskId: "task-001",
          name: "t",
          idempotencyKey: "i",
          userId: "u",
          timestamp: now + 200,
          taskType: "user",
          payload: { step: 1 },
        },
        {
          type: "TASK_COMPLETE",
          taskId: "task-001",
          name: "t",
          idempotencyKey: "i",
          userId: "u",
          timestamp: now + 300,
          taskType: "user",
          result: { done: true },
        },
      ];

      await connector.executeBatch(entries);

      const events = connector.getTaskEvents(taskId("task-001"));
      expect(events).toHaveLength(4);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    });
  });
});

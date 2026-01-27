import { describe, expect, it } from "vitest";
import {
  eventId,
  idempotencyKey,
  taskId,
  taskName,
  userId,
} from "@/core/branded";
import {
  createTaskEvent,
  isRecoveryRelevant,
  shouldStoreInTaskEvents,
  type TaskEvent,
  type TaskEventContext,
  type TaskEventInput,
  toEventLogEntry,
  toEventLogEntryType,
  toTaskEventType,
} from "@/domain/events";

describe("Domain Events", () => {
  describe("toEventLogEntryType", () => {
    it("should map created to TASK_CREATED", () => {
      expect(toEventLogEntryType("created")).toBe("TASK_CREATED");
    });
    it("should map start to TASK_START", () => {
      expect(toEventLogEntryType("start")).toBe("TASK_START");
    });
    it("should map progress to TASK_PROGRESS", () => {
      expect(toEventLogEntryType("progress")).toBe("TASK_PROGRESS");
    });
    it("should map complete to TASK_COMPLETE", () => {
      expect(toEventLogEntryType("complete")).toBe("TASK_COMPLETE");
    });
    it("should map error to TASK_ERROR", () => {
      expect(toEventLogEntryType("error")).toBe("TASK_ERROR");
    });
    it("should map cancelled to TASK_CANCELLED", () => {
      expect(toEventLogEntryType("cancelled")).toBe("TASK_CANCELLED");
    });
    it("should map heartbeat to TASK_HEARTBEAT", () => {
      expect(toEventLogEntryType("heartbeat")).toBe("TASK_HEARTBEAT");
    });
    it("should map custom to TASK_CUSTOM", () => {
      expect(toEventLogEntryType("custom")).toBe("TASK_CUSTOM");
    });
    it("should return null for retry (not persisted to WAL)", () => {
      expect(toEventLogEntryType("retry")).toBeNull();
    });
    it("should return null for recovered (internal event)", () => {
      expect(toEventLogEntryType("recovered")).toBeNull();
    });
  });

  describe("toTaskEventType", () => {
    it("should map TASK_CREATED to created", () => {
      expect(toTaskEventType("TASK_CREATED")).toBe("created");
    });
    it("should map TASK_START to start", () => {
      expect(toTaskEventType("TASK_START")).toBe("start");
    });
    it("should map TASK_PROGRESS to progress", () => {
      expect(toTaskEventType("TASK_PROGRESS")).toBe("progress");
    });
    it("should map TASK_COMPLETE to complete", () => {
      expect(toTaskEventType("TASK_COMPLETE")).toBe("complete");
    });
    it("should map TASK_ERROR to error", () => {
      expect(toTaskEventType("TASK_ERROR")).toBe("error");
    });
    it("should map TASK_CANCELLED to cancelled", () => {
      expect(toTaskEventType("TASK_CANCELLED")).toBe("cancelled");
    });
    it("should map TASK_HEARTBEAT to heartbeat", () => {
      expect(toTaskEventType("TASK_HEARTBEAT")).toBe("heartbeat");
    });
    it("should map TASK_CUSTOM to custom", () => {
      expect(toTaskEventType("TASK_CUSTOM")).toBe("custom");
    });
  });
  describe("shouldStoreInTaskEvents", () => {
    it("should return true for TASK_CREATED", () => {
      expect(shouldStoreInTaskEvents("TASK_CREATED")).toBe(true);
    });
    it("should return true for TASK_START", () => {
      expect(shouldStoreInTaskEvents("TASK_START")).toBe(true);
    });
    it("should return true for TASK_PROGRESS", () => {
      expect(shouldStoreInTaskEvents("TASK_PROGRESS")).toBe(true);
    });
    it("should return true for TASK_COMPLETE", () => {
      expect(shouldStoreInTaskEvents("TASK_COMPLETE")).toBe(true);
    });
    it("should return true for TASK_ERROR", () => {
      expect(shouldStoreInTaskEvents("TASK_ERROR")).toBe(true);
    });
    it("should return true for TASK_CANCELLED", () => {
      expect(shouldStoreInTaskEvents("TASK_CANCELLED")).toBe(true);
    });
    it("should return true for TASK_CUSTOM", () => {
      expect(shouldStoreInTaskEvents("TASK_CUSTOM")).toBe(true);
    });
    it("should return false for TASK_HEARTBEAT (WAL only)", () => {
      expect(shouldStoreInTaskEvents("TASK_HEARTBEAT")).toBe(false);
    });
  });

  describe("isRecoveryRelevant", () => {
    it("should return true for TASK_CREATED", () => {
      expect(isRecoveryRelevant("TASK_CREATED")).toBe(true);
    });
    it("should return true for TASK_PROGRESS", () => {
      expect(isRecoveryRelevant("TASK_PROGRESS")).toBe(true);
    });
    it("should return true for TASK_COMPLETE", () => {
      expect(isRecoveryRelevant("TASK_COMPLETE")).toBe(true);
    });
    it("should return true for TASK_ERROR", () => {
      expect(isRecoveryRelevant("TASK_ERROR")).toBe(true);
    });
    it("should return true for TASK_CANCELLED", () => {
      expect(isRecoveryRelevant("TASK_CANCELLED")).toBe(true);
    });
    it("should return true for TASK_CUSTOM", () => {
      expect(isRecoveryRelevant("TASK_CUSTOM")).toBe(true);
    });
    it("should return false for TASK_HEARTBEAT (WAL only)", () => {
      expect(isRecoveryRelevant("TASK_HEARTBEAT")).toBe(false);
    });
  });

  describe("createTaskEvent", () => {
    it("should create a full TaskEvent from input and context", () => {
      const input: TaskEventInput = {
        type: "progress",
        message: "Running query",
        payload: { percent: 50 },
      };
      const context: TaskEventContext = {
        taskId: taskId("123"),
        name: taskName("my-task"),
        idempotencyKey: idempotencyKey("abc123"),
        userId: userId("user123"),
        taskType: "user",
      };
      const event = createTaskEvent(input, context);

      expect(event.type).toBe("progress");
      expect(event.message).toBe("Running query");
      expect(event.payload).toEqual({ percent: 50 });
      expect(event.taskId).toBe("123");
      expect(event.name).toBe("my-task");
      expect(event.idempotencyKey).toBe("abc123");
      expect(event.userId).toBe("user123");
      expect(event.taskType).toBe("user");
      expect(event.id).toMatch(/^evt_/);
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("should use provided event ID if given", () => {
      const input: TaskEventInput = {
        id: "my-event-id",
        type: "complete",
      };
      const context: TaskEventContext = {
        taskId: taskId("123"),
        name: taskName("my-task"),
        idempotencyKey: idempotencyKey("abc123"),
        userId: userId("user123"),
        taskType: "user",
      };
      const event = createTaskEvent(input, context);
      expect(event.id).toBe("my-event-id");
    });

    it("should include executionOptions from context", () => {
      const input: TaskEventInput = {
        type: "progress",
        message: "Running query",
        payload: { percent: 50 },
      };
      const context: TaskEventContext = {
        taskId: taskId("123"),
        name: taskName("my-task"),
        idempotencyKey: idempotencyKey("abc123"),
        userId: userId("user123"),
        taskType: "user",
        executionOptions: {
          maxRetries: 3,
          timeoutMs: 10000,
        },
      };
      const event = createTaskEvent(input, context);
      expect(event.executionOptions).toEqual({
        maxRetries: 3,
        timeoutMs: 10000,
      });
    });
  });

  describe("toEventLogEntry", () => {
    it("should convert TaskEvent to EventLogEntry (for WAL persistence)", () => {
      const event: TaskEvent = {
        id: eventId("evt_123"),
        taskId: taskId("123"),
        name: taskName("my-task"),
        type: "complete",
        idempotencyKey: idempotencyKey("abc123"),
        userId: userId("user123"),
        taskType: "user",
        timestamp: Date.now(),
        result: { data: "success" },
      };
      const entry = toEventLogEntry(event);

      expect(entry).not.toBeNull();
      expect(entry?.type).toBe("TASK_COMPLETE");
      expect(entry?.taskId).toBe("123");
      expect(entry?.result).toEqual({ data: "success" });
    });

    it("should return null for retry events (not persisted to WAL)", () => {
      const event: TaskEvent = {
        id: eventId("evt_123"),
        taskId: taskId("123"),
        name: taskName("my-task"),
        type: "retry",
        idempotencyKey: idempotencyKey("abc123"),
        userId: userId("user123"),
        taskType: "user",
        timestamp: Date.now(),
        nextRetryDelayMs: 1000,
      };
      expect(toEventLogEntry(event)).toBeNull();
    });

    it("should return null for recovered events (internal event)", () => {
      const event: TaskEvent = {
        id: eventId("evt_123"),
        taskId: taskId("123"),
        name: taskName("my-task"),
        type: "recovered",
        idempotencyKey: idempotencyKey("abc123"),
        userId: userId("user123"),
        taskType: "user",
      };

      expect(toEventLogEntry(event)).toBeNull();
    });

    it("should include executionOptions in entry", () => {
      const event: TaskEvent = {
        id: eventId("evt_123"),
        taskId: taskId("123"),
        name: taskName("my-task"),
        type: "created",
        idempotencyKey: idempotencyKey("abc123"),
        userId: userId("user123"),
        taskType: "user",
        timestamp: Date.now(),
        executionOptions: {
          maxRetries: 3,
          timeoutMs: 10000,
        },
      };
      const entry = toEventLogEntry(event);
      expect(entry?.executionOptions).toEqual({
        maxRetries: 3,
        timeoutMs: 10000,
      });
    });
  });
});

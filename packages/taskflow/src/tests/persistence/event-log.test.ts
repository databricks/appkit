import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventLogEntry, TaskEvent } from "@/domain/events";
import { EventLog } from "@/persistence/event-log";

describe("EventLog", () => {
  let eventLog: EventLog;
  const eventLogPath = "./test-event-log";

  beforeEach(async () => {
    eventLog = new EventLog({ eventLogPath, maxSizeBytesPerFile: 1024 });
    await eventLog.initialize();
  });

  afterEach(async () => {
    await eventLog.close(true);
  });

  it("should create event log file when initialized", async () => {
    const fileExists = await fs
      .access(eventLogPath)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
  });

  it("should append entry to event log file", async () => {
    const entry: EventLogEntry = {
      timestamp: Date.now(),
      taskId: "task-123",
      type: "TASK_CREATED",
      name: "test-task",
      idempotencyKey: "idem-123",
      userId: "user-123",
      taskType: "user",
    };

    await eventLog.appendEntry(entry);
    const content = await fs.readFile(eventLogPath, "utf8");
    const firstLine = content.split("\n")[0];
    const parsed = JSON.parse(firstLine);

    expect(parsed.type).toBe("TASK_CREATED");
    expect(parsed.taskId).toBe("task-123");
    expect(parsed.seq).toBe(1);
  });

  it("should check if rotation is needed", async () => {
    let shouldRotate = await eventLog.shouldRotateEventLog();
    expect(shouldRotate).toBe(false);

    // add enough entries to exceed maxSizeBytesPerFile
    for (let i = 0; i < 10; i++) {
      await eventLog.appendEntry({
        timestamp: Date.now(),
        taskId: `task-${i}`,
        type: "TASK_CREATED",
        name: "test-task",
        idempotencyKey: `key-${i}`,
        userId: "user-123",
        taskType: "user",
        input: { data: "padding".repeat(20) },
      });
    }

    shouldRotate = await eventLog.shouldRotateEventLog();
    expect(shouldRotate).toBe(true);
  });

  it("should compact rotated files removing heartbeats", async () => {
    const base = {
      taskId: "task-123",
      name: "test-task",
      idempotencyKey: "idem-123",
      taskType: "user" as const,
      userId: "user-123",
    };

    await eventLog.appendEntry({
      ...base,
      timestamp: Date.now(),
      type: "TASK_CREATED",
    });
    await eventLog.appendEntry({
      ...base,
      timestamp: Date.now(),
      type: "TASK_HEARTBEAT",
    });
    await eventLog.appendEntry({
      ...base,
      timestamp: Date.now(),
      type: "TASK_HEARTBEAT",
    });
    await eventLog.appendEntry({
      ...base,
      timestamp: Date.now(),
      type: "TASK_HEARTBEAT",
    });

    await eventLog.compactRotatedFile(eventLogPath);
    const content = await fs.readFile(eventLogPath, "utf8");
    const lines = content.split("\n").filter(Boolean);

    // only TASK_CREATED should remain
    expect(lines.length).toBe(1);
  });

  it("should rotate event log file", async () => {
    const base = {
      taskId: "task-123",
      name: "test-task",
      idempotencyKey: "idem-123",
      taskType: "user" as const,
      userId: "user-123",
    };

    // add enough entries to exceed maxSizeBytesPerFile
    for (let i = 0; i < 10; i++) {
      await eventLog.appendEntry({
        ...base,
        timestamp: Date.now(),
        type: "TASK_CREATED",
        input: { data: "padding".repeat(20) },
      });
    }

    await eventLog.performRotation();

    // check rotated file exists
    const rotatedExists = await fs
      .access(`${eventLogPath}.1`)
      .then(() => true)
      .catch(() => false);
    expect(rotatedExists).toBe(true);
  });

  it("should save and restore sequence number", async () => {
    expect(eventLog.currentSeq).toBe(0);

    await eventLog.appendEntry(
      {
        timestamp: Date.now(),
        taskId: "task-123",
        type: "TASK_CREATED",
        name: "test-task",
        idempotencyKey: "idem-123",
        userId: "user-123",
        taskType: "user",
      },
      true,
    );

    expect(eventLog.currentSeq).toBe(1);

    const savedSeq = await fs.readFile(`${eventLogPath}.checkpoint`, "utf8");
    expect(savedSeq).toBe("1");
  });

  it("should append TaskEvent and convert to EventLogEntry", async () => {
    const event = {
      id: "evt-123",
      taskId: "task-123",
      type: "created" as const,
      input: { test: "data" },
      taskType: "user" as const,
      name: "test-task",
      idempotencyKey: "idem-123",
      userId: "user-123",
    } as TaskEvent;

    await eventLog.appendEvent(event);

    const content = await fs.readFile(eventLogPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("TASK_CREATED");
    expect(parsed.input).toEqual({ test: "data" });
  });

  it("should return stats", () => {
    const stats = eventLog.getStats();

    expect(stats.status.initialized).toBe(true);
    expect(stats.status.path).toBe(eventLogPath);
    expect(stats.sequence.current).toBe(0);
    expect(stats.rotation.count).toBe(0);
    expect(stats.rotation.isActive).toBe(false);
    expect(stats.volume.entriesWritten).toBe(0);
  });
});

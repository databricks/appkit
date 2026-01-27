import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "json-canonicalize";
import { EventLogError } from "@/core/errors";
import type { TaskStatus } from "@/core/types";
import type { EventLogEntry, TaskEvent } from "@/domain";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  type TaskSystemHooks,
} from "@/observability";
import {
  DEFAULT_EVENT_LOG_CONFIG,
  type EventLogConfig,
  type EventLogEvent,
  type EventLogStats,
} from "./types";

/**
 * Event Log - File-based Write-Ahead log
 *
 * Provides durable event storage with:
 * - Append-only file operations
 * - Optional fsync for critical events
 * - Rotation based on size/age
 * - Compaction of rotated files
 * - Checkpoint-based recovery
 */
export class EventLog {
  private config: EventLogConfig;
  private hooks: TaskSystemHooks;

  private fileHandle: fs.FileHandle | null = null;

  private rotationInterval?: ReturnType<typeof setInterval>;
  private rotationLock: Promise<void> = Promise.resolve();
  private lastRotationAt: number | null = null;
  private isRotating = false;

  /** current sequence number */
  currentSeq = 0;
  /** number of rotations performed */
  rotationCount = 0;
  /** total entries written */
  private entriesWritten = 0;
  /** count of malformed entries skipped during reads */
  private malformedEntriesSkipped = 0;

  constructor(
    config: Partial<EventLogConfig>,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.config = { ...DEFAULT_EVENT_LOG_CONFIG, ...config };
    this.hooks = hooks;

    // validate event log path
    this.validatePath(this.config.eventLogPath);
  }

  /**
   * Initialize the event log
   * Creates the log file and checkpoint, schedule rotation
   */
  async initialize(): Promise<void> {
    // create the directory if it doesn't exist
    const dir = path.dirname(this.config.eventLogPath);
    await fs.mkdir(dir, { recursive: true });
    this.fileHandle = await fs.open(this.config.eventLogPath, "a");

    // load or create checkpoint
    const previousSeq = await this.loadCheckpoint();
    this.currentSeq = previousSeq;
    await fs.writeFile(
      `${this.config.eventLogPath}.checkpoint`,
      this.currentSeq.toString(),
      "utf8",
    );

    this.scheduleRotation();

    this.hooks?.log({
      severity: "info",
      message: "Event log initialized",
      attributes: {
        [TaskAttributes.EVENTLOG_PATH]: this.config.eventLogPath,
        [TaskAttributes.EVENTLOG_SEQUENCE]: this.currentSeq,
      },
    });

    this.hooks?.recordGauge(TaskMetrics.EVENTLOG_SEQUENCE, this.currentSeq, {
      [TaskAttributes.EVENTLOG_PATH]: this.config.eventLogPath,
    });
  }

  /**
   * Append an entry to the log file
   * @param entry - The entry to append
   * @param fsync - Whether force sync to disk (critical events)
   */
  async appendEntry(entry: EventLogEntry, fsync = false): Promise<void> {
    if (!this.fileHandle) return;

    const startTime = Date.now();

    // wait for any ongoing rotation to complete
    await this.rotationLock;

    try {
      this.currentSeq++;
      this.entriesWritten++;

      const eventPayload: EventLogEvent = {
        seq: this.currentSeq,
        ...entry,
      };

      // compute checksum
      eventPayload.checksum = this.computeChecksum(eventPayload);

      // write to file
      const line = `${JSON.stringify(eventPayload)}\n`;
      await this.fileHandle.write(line);

      if (fsync) await this.fileHandle.sync();

      // save checkpoint periodically or on fsync
      if (this.currentSeq % 100 === 0 || fsync) {
        await this.saveCheckpoint();
      }

      this.hooks?.incrementCounter(TaskMetrics.EVENTLOG_ENTRIES_WRITTEN, 1, {
        [TaskAttributes.EVENT_TYPE]: entry.type,
        [TaskAttributes.EVENTLOG_FSYNC]: fsync,
      });

      this.hooks?.recordHistogram(
        TaskMetrics.EVENTLOG_WRITE_LATENCY_MS,
        Date.now() - startTime,
        {
          [TaskAttributes.EVENT_TYPE]: entry.type,
        },
      );

      this.hooks?.recordGauge(TaskMetrics.EVENTLOG_SEQUENCE, this.currentSeq);
    } catch (error) {
      const eventLogError = new EventLogError(
        "Failed to append entry to event log",
        "write",
        this.config.eventLogPath,
        error instanceof Error ? error : new Error(String(error)),
      );

      this.hooks?.log({
        severity: "error",
        message: eventLogError.message,
        error: eventLogError,
        attributes: {
          taskId: entry.taskId,
          [TaskAttributes.EVENT_TYPE]: entry.type,
        },
      });

      throw eventLogError;
    }
  }

  /**
   * Append a TaskEvent to the log
   * Converts TaskEvent to EventLogEntry format
   */
  async appendEvent(event: TaskEvent): Promise<void> {
    const base = {
      taskId: event.taskId,
      idempotencyKey: event.idempotencyKey,
      name: event.name,
      userId: event.userId ?? null,
      taskType: event.taskType,
      timestamp: event.timestamp ?? Date.now(),
    };

    switch (event.type) {
      case "created":
        await this.appendEntry(
          {
            ...base,
            type: "TASK_CREATED",
            input: event.input,
            executionOptions: event.executionOptions,
          },
          true,
        );
        break;
      case "start":
        await this.appendEntry(
          {
            ...base,
            type: "TASK_START",
          },
          true,
        );
        break;
      case "progress":
        await this.appendEntry({
          ...base,
          type: "TASK_PROGRESS",
          payload: event.payload,
        });
        break;
      case "complete":
        await this.appendEntry(
          {
            ...base,
            type: "TASK_COMPLETE",
            result: event.result,
          },
          true,
        );
        break;
      case "heartbeat":
        await this.appendEntry({
          ...base,
          type: "TASK_HEARTBEAT",
        });
        break;
      case "error":
        await this.appendEntry(
          {
            ...base,
            type: "TASK_CANCELLED",
            error: event.error ?? "Unknown reason",
          },
          true,
        );
        break;
      case "custom":
        await this.appendEntry({
          ...base,
          type: "TASK_CUSTOM",
          payload: {
            eventName: event.eventName,
            ...event.payload,
          },
        });
        break;
    }
  }

  /**
   * Read entries from a checkpoint position
   * Used by flush worker to get entries to flush
   */
  async readEntriesFromCheckpoint(
    checkpoint: number,
  ): Promise<EventLogEntry[]> {
    const entries = await this.readEntries(this.config.eventLogPath);
    return entries.filter((entry) => {
      const eventLogPath = entry as EventLogEvent;
      return eventLogPath.seq > checkpoint;
    });
  }

  /**
   * Get the current sequence number from checkpoint file
   */
  async getSequenceNumber(): Promise<number> {
    const seqFilePath = `${this.config.eventLogPath}.checkpoint`;
    try {
      const seq = await fs.readFile(seqFilePath, "utf8");
      return parseInt(seq, 10);
    } catch {
      return 0;
    }
  }

  /**
   * Check if log file should be rotated
   */
  async shouldRotateEventLog(): Promise<boolean> {
    try {
      const stats = await fs.stat(this.config.eventLogPath);
      const age = Date.now() - stats.mtime.getTime();
      return (
        stats.size >= this.config.maxSizeBytesPerFile ||
        age >= this.config.maxAgePerFile
      );
    } catch {
      return false;
    }
  }

  /**
   * Perform rotation if needed
   */
  async performRotation(): Promise<void> {
    if (this.isRotating) return;

    if (await this.shouldRotateEventLog()) {
      await this.rotateEventLog();
    }
  }

  /**
   * Compact a rotated log file
   * Removes heartbeats and entries for completed/old failed tasks
   */
  async compactRotatedFile(filePath: string): Promise<void> {
    const startTime = Date.now();

    try {
      const entries = await this.readEntries(filePath);

      const tasksState = this.buildTaskState(entries);
      const failedThresholdMs = Date.now() - 1000 * 60 * 60 * 24; // 24 hours

      // filter entries
      const compactedEntries = entries.filter((entry) => {
        const taskId = entry.taskId;
        const finalState = tasksState.get(taskId);

        if (!finalState) return false;

        // remove completed task entries
        if (finalState === "completed") return false;

        // remove old failed/cancelled entries
        if (
          finalState === "failed" ||
          (finalState === "cancelled" && entry.timestamp < failedThresholdMs)
        )
          return false;

        // remove heartbeats
        if (entry.type === "TASK_HEARTBEAT") return false;

        return true;
      });

      // write compacted entries
      const content = compactedEntries
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      await fs.writeFile(filePath, content, "utf8");

      this.hooks?.incrementCounter(TaskMetrics.EVENTLOG_COMPACTIONS, 1);

      this.hooks?.log({
        severity: "info",
        message: "Compacted rotated file",
        attributes: {
          [TaskAttributes.EVENTLOG_PATH]: filePath,
          [TaskAttributes.EVENTLOG_COMPACTIONS]: compactedEntries.length,
          [TaskAttributes.EVENTLOG_COMPACTION_DURATION_MS]:
            Date.now() - startTime,
        },
      });
    } catch (error) {
      throw new EventLogError(
        "Failed to compact rotated file",
        "compact",
        filePath,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Get event log statistics
   */
  getStats(): EventLogStats {
    return {
      status: {
        initialized: this.fileHandle !== null,
        path: this.config.eventLogPath,
      },
      sequence: {
        current: this.currentSeq,
      },
      rotation: {
        count: this.rotationCount,
        isActive: this.isRotating,
        lastAt: this.lastRotationAt ?? undefined,
      },
      volume: {
        entriesWritten: this.entriesWritten,
        malformedSkipped: this.malformedEntriesSkipped,
      },
    };
  }

  /**
   * Close the event log
   * @param deleteFiles - Whether to delete the log files
   */
  async close(deleteFiles = false): Promise<void> {
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
      this.rotationInterval = undefined;
    }

    if (this.fileHandle) {
      await this.saveCheckpoint();
      await this.fileHandle.sync();
      await this.fileHandle.close();
      this.fileHandle = null;
    }

    this.currentSeq = 0;

    if (deleteFiles) {
      try {
        await fs.unlink(this.config.eventLogPath);
      } catch {
        // ignore if file doesn't exist
      }

      // delete rotated files
      for (let i = 0; i < this.config.retentionCount; i++) {
        try {
          await fs.unlink(`${this.config.eventLogPath}.${i}`);
        } catch {
          // ignore if file doesn't exist
        }
      }

      // delete checkpoint file
      try {
        await fs.unlink(`${this.config.eventLogPath}.checkpoint`);
      } catch {
        // ignore if file doesn't exist
      }
    }
  }

  private validatePath(eventLogPath: string): void {
    // prevent path traversal
    const normalizedPath = path.normalize(eventLogPath);
    if (normalizedPath.includes("..")) {
      throw new Error(
        `Invalid event log path: path traversal detected in "${eventLogPath}"`,
      );
    }

    // warn if absolute path outside project
    if (path.isAbsolute(normalizedPath)) {
      this.hooks?.log({
        severity: "warn",
        message: "EventLog using absolute path",
        attributes: {
          path: normalizedPath,
        },
      });
    }
  }

  private scheduleRotation(): void {
    // schedule rotation check at configured interval
    this.rotationInterval = setInterval(async () => {
      if (await this.shouldRotateEventLog()) {
        await this.rotateEventLog();
      }
    }, this.config.rotationInterval);

    // don't keep the process alive just for rotation
    this.rotationInterval.unref();
  }

  private async rotateEventLog(): Promise<void> {
    const startTime = Date.now();

    // set the new lock
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // wait for any existing rotation
    await this.rotationLock;

    // set the new lock
    this.rotationLock = lockPromise;
    this.isRotating = true;

    try {
      await this.saveCheckpoint();

      if (this.fileHandle) {
        await this.fileHandle.close();

        // shift existing rotated files
        for (let i = this.rotationCount; i >= 1; i--) {
          const current = `${this.config.eventLogPath}.${i}`;
          const next = `${this.config.eventLogPath}.${i + 1}`;
          const currentExists = await fs
            .access(current)
            .then(() => true)
            .catch(() => false);

          // rename current to next if current exists
          if (currentExists) {
            await fs.rename(current, next);
          }
        }

        // rename current file to .1
        const rotatedPath = `${this.config.eventLogPath}.1`;
        await fs.rename(this.config.eventLogPath, rotatedPath);
        this.rotationCount++;
        this.lastRotationAt = Date.now();

        // compact the rotated file
        await this.compactRotatedFile(rotatedPath);

        // cleanup old files
        await this.cleanupOldRotatedFiles(this.rotationCount);

        this.hooks?.incrementCounter(TaskMetrics.EVENTLOG_ROTATIONS, 1);

        this.hooks?.recordHistogram(
          TaskMetrics.EVENTLOG_ROTATION_DURATION_MS,
          Date.now() - startTime,
        );
      }

      // open new file handle
      this.fileHandle = await fs.open(this.config.eventLogPath, "a+");
    } catch (error) {
      throw new EventLogError(
        "Failed to rotate event log",
        "rotate",
        this.config.eventLogPath,
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      this.isRotating = false;
      releaseLock!();

      this.rotationLock = Promise.resolve();
    }
  }

  private async cleanupOldRotatedFiles(currentCount: number): Promise<void> {
    // iterate over all rotated files except the current one
    for (let i = this.config.retentionCount + 1; i < currentCount; i++) {
      const filePath = `${this.config.eventLogPath}.${i}`;
      const fileExists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);

      if (fileExists) {
        await fs.unlink(filePath);
      } else {
        break;
      }
    }
  }

  private async readEntries(filePath: string): Promise<EventLogEntry[]> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);

      const entries: EventLogEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as EventLogEvent;
          entries.push(entry);
        } catch {
          this.malformedEntriesSkipped++;

          this.hooks?.incrementCounter(
            TaskMetrics.EVENTLOG_MALFORMED_SKIPPED,
            1,
          );

          this.hooks?.log({
            severity: "warn",
            message: "Skipped malformed event log entry",
            attributes: {
              path: filePath,
              linePreview: line.substring(0, 100),
            },
          });
        }
      }

      return entries;
    } catch (error) {
      throw new EventLogError(
        "Failed to read event log entries",
        "read",
        filePath,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private buildTaskState(entries: EventLogEntry[]): Map<string, TaskStatus> {
    const taskState = new Map<string, TaskStatus>();

    for (const entry of entries) {
      const taskId = entry.taskId;

      switch (entry.type) {
        case "TASK_CREATED":
          taskState.set(taskId, "created");
          break;
        case "TASK_START":
          taskState.set(taskId, "running");
          break;
        case "TASK_COMPLETE":
          taskState.set(taskId, "completed");
          break;
        case "TASK_CANCELLED":
          taskState.set(taskId, "cancelled");
          break;
        case "TASK_ERROR":
          taskState.set(taskId, "failed");
          break;
        case "TASK_PROGRESS":
          taskState.set(taskId, "running");
          break;
        case "TASK_HEARTBEAT":
          // no stage change
          break;
      }
    }

    return taskState;
  }

  private async saveCheckpoint(): Promise<void> {
    const seqFilePath = `${this.config.eventLogPath}.checkpoint`;
    await fs.writeFile(seqFilePath, this.currentSeq.toString(), "utf8");
  }

  private async loadCheckpoint(): Promise<number> {
    try {
      const seqFilePath = `${this.config.eventLogPath}.checkpoint`;
      const seq = await fs.readFile(seqFilePath, "utf8");
      return parseInt(seq, 10);
    } catch {
      return 0;
    }
  }

  private computeChecksum(event: EventLogEvent): string {
    const { checksum: _checksum, ...payloadWithoutChecksum } = event;
    return createHash("sha256")
      .update(canonicalize(payloadWithoutChecksum))
      .digest("hex");
  }
}

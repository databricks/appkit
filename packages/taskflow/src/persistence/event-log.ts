import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { canonicalize } from "json-canonicalize";
import { EventLogError } from "@/core/errors";
import type { TaskStatus } from "@/core/types";
import { type EventLogEntry, type TaskEvent, toEventLogEntry } from "@/domain";
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
  /** current file size in bytes (tracked in memory for reliable rotation checks) */
  private currentFileSize = 0;

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

    // initialize file size from existing file
    try {
      const stats = await fs.stat(this.config.eventLogPath);
      this.currentFileSize = stats.size;
    } catch {
      this.currentFileSize = 0;
    }

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
      const lineBytes = Buffer.byteLength(line, "utf8");
      await this.fileHandle.write(line);
      this.currentFileSize += lineBytes;

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
    const entry = toEventLogEntry(event);
    if (!entry) {
      return;
    }

    // critical events to be written to disk immediately
    const criticalEvents = [
      "TASK_CREATED",
      "TASK_START",
      "TASK_COMPLETE",
      "TASK_ERROR",
      "TASK_CANCELLED",
    ];
    const fsync = criticalEvents.includes(entry.type);

    await this.appendEntry(entry, fsync);
  }

  /**
   * Read entries from a checkpoint position
   * Used by flush worker to get entries to flush
   */
  async readEntriesFromCheckpoint(
    checkpoint: number,
    limit: number = 1000,
  ): Promise<EventLogEntry[]> {
    const entries: EventLogEntry[] = [];

    const stream = this.createStreamReader();
    if (!stream) return entries;

    try {
      // read entries from checkpoint position
      for await (const line of stream.readline) {
        if (!line.trim()) continue;

        // parse entry
        try {
          const entry = JSON.parse(line) as EventLogEvent;

          // skip entries already processed
          if (entry.seq <= checkpoint) continue;

          entries.push(entry);

          // stop early once we have enough entries
          if (entries.length >= limit) break;
        } catch {
          this.malformedEntriesSkipped++;
          this.hooks?.incrementCounter(
            TaskMetrics.EVENTLOG_MALFORMED_SKIPPED,
            1,
          );
        }
      }
    } finally {
      stream.close();
    }

    return entries;
  }

  /**
   * Read entries starting from a byte offset
   */
  async readEntriesFromByteOffset(
    byteOffset: number,
    limit: number = 1000,
  ): Promise<{ entries: EventLogEntry[]; newByteOffset: number }> {
    const entries: EventLogEntry[] = [];
    let currentOffset = byteOffset;

    // check if rotation happened
    const rotationResult = await this.handleRotationIfNeeded(byteOffset, limit);
    if (rotationResult) {
      // rotation detected, read from rotated file first
      entries.push(...rotationResult.entries);
      if (entries.length >= limit) {
        return {
          entries: entries.slice(0, limit),
          newByteOffset: rotationResult.newByteOffset,
        };
      }
      // continue reading from current file
      currentOffset = 0;
      limit -= entries.length;
    }

    const stream = this.createStreamReaderFromOffset(currentOffset);
    if (!stream) return { entries, newByteOffset: currentOffset };

    try {
      for await (const line of stream.readline) {
        // compute line bytes
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1;

        if (!line.trim()) {
          currentOffset += lineBytes;
          continue;
        }

        try {
          const entry = JSON.parse(line) as EventLogEvent;
          entries.push(entry);
          currentOffset += lineBytes;

          // stop early once we have enough entries
          if (entries.length >= limit) break;
        } catch {
          // malformed line, skip but still advance offset
          currentOffset += lineBytes;
          this.malformedEntriesSkipped++;
          this.hooks?.incrementCounter(
            TaskMetrics.EVENTLOG_MALFORMED_SKIPPED,
            1,
          );
        }
      }
    } finally {
      stream.close();
    }

    return { entries, newByteOffset: currentOffset };
  }

  /**
   * Check if rotation happened and read remaining entries from rotated file
   */
  private async handleRotationIfNeeded(
    byteOffset: number,
    limit: number,
  ): Promise<{ entries: EventLogEntry[]; newByteOffset: number } | null> {
    if (byteOffset === 0) return null;

    try {
      const stats = await fs.stat(this.config.eventLogPath);

      // no rotation, return null
      if (stats.size >= byteOffset) return null;

      // get rotated file path
      const rotatedPath = `${this.config.eventLogPath}.1`;

      try {
        await fs.access(rotatedPath);
      } catch {
        // log rotation was detected but rotated file not found
        this.hooks?.log({
          severity: "warn",
          message:
            "Rotation detected but rotated file not found, resetting offset",
          attributes: { byteOffset, currentFileSize: stats.size },
        });
        return { entries: [], newByteOffset: 0 };
      }

      // read entries from rotated file
      const entries: EventLogEntry[] = [];

      const fileStream = createReadStream(rotatedPath, {
        encoding: "utf-8",
        start: byteOffset,
      });

      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      try {
        for await (const line of rl) {
          if (!line.trim()) continue;

          try {
            const entry = JSON.parse(line) as EventLogEvent;
            entries.push(entry);
            if (entries.length >= limit) break;
          } catch {
            this.malformedEntriesSkipped++;
          }
        }
      } finally {
        rl.close();
        fileStream.destroy();
      }

      this.hooks?.log({
        severity: "info",
        message: "Read entries from rotated file after rotation",
        attributes: { entriesRead: entries.length, fromOffset: byteOffset },
      });

      // return entries, signal to continue from offset 0 in current file
      return { entries, newByteOffset: 0 };
    } catch {
      return { entries: [], newByteOffset: 0 };
    }
  }

  private createStreamReader(): {
    readline: Interface;
    close: () => void;
  } | null {
    return this.createStreamReaderFromOffset(0);
  }

  private createStreamReaderFromOffset(byteOffset: number): {
    readline: Interface;
    close: () => void;
  } | null {
    try {
      // check if file exists
      const fileStream = createReadStream(this.config.eventLogPath, {
        encoding: "utf-8",
        start: byteOffset,
      });

      // handle file not found error
      fileStream.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // file not found error, destroy stream
          fileStream.destroy();
        }
      });

      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      return {
        readline: rl,
        close: () => {
          rl.close();
          fileStream.destroy();
        },
      };
    } catch {
      return null;
    }
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
    // use tracked file size for reliable size-based rotation
    if (this.currentFileSize >= this.config.maxSizeBytesPerFile) {
      return true;
    }

    // check age-based rotation using fs.stat
    try {
      const stats = await fs.stat(this.config.eventLogPath);
      const age = Date.now() - stats.mtime.getTime();
      return age >= this.config.maxAgePerFile;
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
   * Sync all buffered writes to disk
   */
  async sync(): Promise<void> {
    // wait for ongoing rotation
    await this.rotationLock;

    if (this.fileHandle) {
      try {
        await this.saveCheckpoint();
        await this.fileHandle.sync();
      } catch (error) {
        // handle file closed error
        if (error instanceof Error && error.message.includes("file closed")) {
          this.hooks?.log({
            severity: "warn",
            message: "File handle closed during sync, likely due to rotation",
          });
          return;
        }
        throw error;
      }
    }
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
    this.currentFileSize = 0;

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

      // open new file handle and reset tracked size
      this.fileHandle = await fs.open(this.config.eventLogPath, "a+");
      this.currentFileSize = 0;
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
    const dir = path.dirname(seqFilePath);
    await fs.mkdir(dir, { recursive: true });
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

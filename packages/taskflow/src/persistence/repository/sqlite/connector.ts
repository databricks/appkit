import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database, { type Statement } from "better-sqlite3";
import type { IdempotencyKey, TaskId } from "@/core/branded";
import { RepositoryError } from "@/core/errors";
import type { TaskStatus } from "@/core/types";
import { type EventLogEntry, type EventLogEntryType, Task } from "@/domain";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  type TaskSystemHooks,
} from "@/observability";
import type { StoredEvent } from "../types";
import type {
  SQLiteConfig,
  SQLiteTaskEventRecord,
  SQLiteTaskRecord,
} from "./types";

/**
 * Default retry configuration for SQLite operations
 */
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
};

/**
 * Cached prepared statements
 */
interface PreparedStatements {
  insertTask: Statement;
  updateTaskStart: Statement;
  updateTaskComplete: Statement;
  updateTaskError: Statement;
  updateTaskCancelled: Statement;
  updateTaskHeartbeat: Statement;
  insertTaskEvent: Statement;
}

/**
 * SQLite Connector
 *
 * Low-level SQLite operations for task persistence
 * Handles schema migrations, batch execution, and queries.
 */
export class SQLiteConnector {
  private db: Database.Database;
  private _isInitialized = false;
  private hooks: TaskSystemHooks;
  private statements: PreparedStatements | null = null;

  constructor(config: SQLiteConfig, hooks: TaskSystemHooks = noopHooks) {
    this.db = new Database(config.database ?? "./.taskflow/sqlite.db");
    this.hooks = hooks;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Initialize the database
   * Enables WAL mode, runs migrations, and prepares statements
   */
  async initialize(): Promise<void> {
    // enable WAL mode for better performance
    this.db.pragma("journal_mode = WAL");
    // disable foreign key enforcement (consistency via event ordering)
    this.db.pragma("foreign_keys = OFF");
    // optimize for concurrent reads
    this.db.pragma("synchronous = NORMAL");

    // run migrations
    await this.runMigrations();

    // prepare all statements once for reuse
    this.prepareStatements();

    this._isInitialized = true;

    this.hooks.log({
      severity: "info",
      message: "SQLite connector initialized",
      attributes: {
        [TaskAttributes.REPOSITORY_TYPE]: "sqlite",
      },
    });
  }

  /**
   * Prepare all SQL statements for reuse
   */
  private prepareStatements(): void {
    this.statements = {
      insertTask: this.db.prepare(`
        INSERT OR IGNORE INTO tasks (task_id, name, status, type, idempotency_key, user_id, input_data, execution_options, created_at, last_heartbeat_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateTaskStart: this.db.prepare(`
        UPDATE tasks SET status = ?, started_at = ?, last_heartbeat_at = ? WHERE task_id = ?
      `),
      updateTaskComplete: this.db.prepare(`
        UPDATE tasks SET status = ?, completed_at = ?, result = ? WHERE task_id = ?
      `),
      updateTaskError: this.db.prepare(`
        UPDATE tasks SET status = ?, completed_at = ?, error = ?, attempt = attempt + 1 WHERE task_id = ?
      `),
      updateTaskCancelled: this.db.prepare(`
        UPDATE tasks SET status = ?, completed_at = ?, error = ? WHERE task_id = ?
      `),
      updateTaskHeartbeat: this.db.prepare(`
        UPDATE tasks SET last_heartbeat_at = ? WHERE task_id = ?
      `),
      insertTaskEvent: this.db.prepare(`
        INSERT OR IGNORE INTO task_events (entry_id, task_id, seq, type, timestamp, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
    };
  }

  /**
   * Execute a batch of events in a transaction using bulk operations
   */
  async executeBatch(batch: EventLogEntry[]): Promise<void> {
    if (batch.length === 0) return;

    const startTime = Date.now();

    await this.withRetry(async () => {
      const transaction = this.db.transaction((entries: EventLogEntry[]) => {
        this.executeBulkOperations(entries);
      });
      transaction(batch);
    }, "executeBatch");

    this.hooks.incrementCounter(TaskMetrics.REPOSITORY_BATCH_EXECUTED, 1, {
      [TaskAttributes.REPOSITORY_TYPE]: "sqlite",
      [TaskAttributes.BATCH_SIZE]: batch.length,
    });

    this.hooks?.recordHistogram(
      TaskMetrics.REPOSITORY_BATCH_LATENCY_MS,
      Date.now() - startTime,
      { [TaskAttributes.REPOSITORY_TYPE]: "sqlite" },
    );
  }

  /**
   * Execute bulk operations for a batch of entries
   */
  private executeBulkOperations(entries: EventLogEntry[]): void {
    // collect entries by type
    const taskCreated: Array<{ entry: EventLogEntry; seq: number }> = [];
    const taskStart: Array<{ entry: EventLogEntry; seq: number }> = [];
    const taskComplete: Array<{ entry: EventLogEntry; seq: number }> = [];
    const taskError: Array<{ entry: EventLogEntry; seq: number }> = [];
    const taskCancelled: Array<{ entry: EventLogEntry; seq: number }> = [];
    const taskProgress: Array<{ entry: EventLogEntry; seq: number }> = [];
    const taskHeartbeat: EventLogEntry[] = [];
    const taskCustom: Array<{ entry: EventLogEntry; seq: number }> = [];

    for (const entry of entries) {
      const seq = (entry as EventLogEntry & { seq?: number }).seq ?? 0;
      switch (entry.type) {
        case "TASK_CREATED":
          taskCreated.push({ entry, seq });
          break;
        case "TASK_START":
          taskStart.push({ entry, seq });
          break;
        case "TASK_COMPLETE":
          taskComplete.push({ entry, seq });
          break;
        case "TASK_ERROR":
          taskError.push({ entry, seq });
          break;
        case "TASK_CANCELLED":
          taskCancelled.push({ entry, seq });
          break;
        case "TASK_PROGRESS":
          taskProgress.push({ entry, seq });
          break;
        case "TASK_HEARTBEAT":
          taskHeartbeat.push(entry);
          break;
        case "TASK_CUSTOM":
          taskCustom.push({ entry, seq });
          break;
      }
    }

    // execute bulk operations for each type
    if (taskCreated.length > 0) this.bulkInsertTasks(taskCreated);
    if (taskStart.length > 0) this.bulkUpdateTaskStart(taskStart);
    if (taskComplete.length > 0) this.bulkUpdateTaskComplete(taskComplete);
    if (taskError.length > 0) this.bulkUpdateTaskError(taskError);
    if (taskCancelled.length > 0) this.bulkUpdateTaskCancelled(taskCancelled);
    if (taskProgress.length > 0) this.bulkUpdateTaskProgress(taskProgress);
    if (taskHeartbeat.length > 0) this.bulkUpdateHeartbeat(taskHeartbeat);
    if (taskCustom.length > 0) this.bulkUpdateTaskCustom(taskCustom);
  }

  /**
   * Bulk insert tasks and their created events
   */
  private bulkInsertTasks(
    items: Array<{ entry: EventLogEntry; seq: number }>,
  ): void {
    for (const { entry, seq } of items) {
      this.statements!.insertTask.run(
        entry.taskId,
        entry.name,
        "created",
        entry.taskType,
        entry.idempotencyKey,
        entry.userId ?? null,
        entry.input ? JSON.stringify(entry.input) : null,
        entry.executionOptions ? JSON.stringify(entry.executionOptions) : null,
        new Date(entry.timestamp).toISOString(),
        new Date(entry.timestamp).toISOString(),
      );
      this.insertTaskEvent(entry.taskId, "TASK_CREATED", seq, entry.timestamp, {
        name: entry.name,
        taskType: entry.taskType,
        idempotencyKey: entry.idempotencyKey,
        userId: entry.userId,
        input: entry.input,
      });
    }
  }

  /**
   * Bulk update tasks to running status
   */
  private bulkUpdateTaskStart(
    items: Array<{ entry: EventLogEntry; seq: number }>,
  ): void {
    if (items.length === 0) return;

    const taskIds = items.map((i) => i.entry.taskId);
    const timestamp = new Date().toISOString();
    const placeholders = taskIds.map(() => "?").join(",");

    this.db
      .prepare(`
      UPDATE tasks SET status = 'running', started_at = ?, last_heartbeat_at = ?
      WHERE task_id IN (${placeholders})
    `)
      .run(timestamp, timestamp, ...taskIds);

    // insert events
    for (const { entry, seq } of items) {
      this.insertTaskEvent(entry.taskId, "TASK_START", seq, entry.timestamp);
    }
  }

  /**
   * Bulk update tasks to completed status
   */
  private bulkUpdateTaskComplete(
    items: Array<{ entry: EventLogEntry; seq: number }>,
  ): void {
    if (items.length === 0) return;

    // we need individual updates due to different results
    for (const { entry, seq } of items) {
      this.statements!.updateTaskComplete.run(
        "completed",
        new Date(entry.timestamp).toISOString(),
        entry.result ? JSON.stringify(entry.result) : null,
        entry.taskId,
      );
      this.insertTaskEvent(
        entry.taskId,
        "TASK_COMPLETE",
        seq,
        entry.timestamp,
        {
          result: entry.result,
        },
      );
    }
  }

  /**
   * Bulk update tasks to failed status
   */
  private bulkUpdateTaskError(
    items: Array<{ entry: EventLogEntry; seq: number }>,
  ): void {
    if (items.length === 0) return;

    // we need individual updates due to different error messages
    for (const { entry, seq } of items) {
      this.statements!.updateTaskError.run(
        "failed",
        new Date(entry.timestamp).toISOString(),
        entry.error ?? null,
        entry.taskId,
      );
      this.insertTaskEvent(entry.taskId, "TASK_ERROR", seq, entry.timestamp, {
        error: entry.error,
      });
    }
  }

  /**
   * Bulk update tasks to cancelled status
   */
  private bulkUpdateTaskCancelled(
    items: Array<{ entry: EventLogEntry; seq: number }>,
  ): void {
    if (items.length === 0) return;

    const taskIds = items.map((i) => i.entry.taskId);
    const timestamp = new Date().toISOString();
    const placeholders = taskIds.map(() => "?").join(",");

    this.db
      .prepare(`
      UPDATE tasks SET status = 'cancelled', completed_at = ?
      WHERE task_id IN (${placeholders})
    `)
      .run(timestamp, ...taskIds);

    for (const { entry, seq } of items) {
      this.insertTaskEvent(
        entry.taskId,
        "TASK_CANCELLED",
        seq,
        entry.timestamp,
        {
          error: entry.error,
        },
      );
    }
  }

  /**
   * Bulk update task progress (heartbeat + event)
   */
  private bulkUpdateTaskProgress(
    items: Array<{ entry: EventLogEntry; seq: number }>,
  ): void {
    if (items.length === 0) return;

    const taskIds = items.map((i) => i.entry.taskId);
    const timestamp = new Date().toISOString();
    const placeholders = taskIds.map(() => "?").join(",");

    this.db
      .prepare(`
      UPDATE tasks SET last_heartbeat_at = ?
      WHERE task_id IN (${placeholders})
    `)
      .run(timestamp, ...taskIds);

    for (const { entry, seq } of items) {
      this.insertTaskEvent(
        entry.taskId,
        "TASK_PROGRESS",
        seq,
        entry.timestamp,
        {
          ...entry.payload,
        },
      );
    }
  }

  /**
   * Bulk update heartbeats (no event insertion)
   */
  private bulkUpdateHeartbeat(entries: EventLogEntry[]): void {
    if (entries.length === 0) return;

    const taskIds = entries.map((e) => e.taskId);
    const timestamp = new Date().toISOString();
    const placeholders = taskIds.map(() => "?").join(",");

    this.db
      .prepare(`
      UPDATE tasks SET last_heartbeat_at = ?
      WHERE task_id IN (${placeholders})
    `)
      .run(timestamp, ...taskIds);
  }

  /**
   * Bulk update custom events
   */
  private bulkUpdateTaskCustom(
    items: Array<{ entry: EventLogEntry; seq: number }>,
  ): void {
    if (items.length === 0) return;

    const taskIds = items.map((i) => i.entry.taskId);
    const timestamp = new Date().toISOString();
    const placeholders = taskIds.map(() => "?").join(",");

    this.db
      .prepare(`
      UPDATE tasks SET last_heartbeat_at = ?
      WHERE task_id IN (${placeholders})
    `)
      .run(timestamp, ...taskIds);

    for (const { entry, seq } of items) {
      this.insertTaskEvent(entry.taskId, "TASK_CUSTOM", seq, entry.timestamp, {
        ...entry.payload,
      });
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    this.db.close();
    this._isInitialized = false;
  }

  healthCheck(): boolean {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find a task by ID
   */
  findTaskById(taskId: TaskId): Task | null {
    const stmt = this.db.prepare(`
        SELECT * from tasks where task_id = ?
    `);

    const record = stmt.get(taskId);
    if (!record) return null;

    return this.mapTaskRecord(record as SQLiteTaskRecord);
  }

  /**
   * Find a task by idempotency key
   */
  findTaskByIdempotencyKey(idempotencyKey: IdempotencyKey): Task | null {
    const stmt = this.db.prepare(`
        SELECT * from tasks where idempotency_key = ?
    `);

    const record = stmt.get(idempotencyKey);
    if (!record) return null;

    return this.mapTaskRecord(record as SQLiteTaskRecord);
  }

  /**
   * Find stale running tasks
   * Tasks whose last heartbeat is older than the threshold
   */
  findStaleTasks(staleThresholdMs: number): Task[] {
    const thresholdDateMs = new Date(
      Date.now() - staleThresholdMs,
    ).toISOString();
    const stmt = this.db.prepare(`
        SELECT * from tasks where status = 'running' and last_heartbeat_at < ?
    `);

    const records = stmt.all(thresholdDateMs);
    return records.map((record) =>
      this.mapTaskRecord(record as SQLiteTaskRecord),
    );
  }

  /**
   * Get task events by task ID, ordered by sequence
   */
  getTaskEvents(taskId: TaskId): StoredEvent[] {
    const stmt = this.db.prepare(`
        SELECT * from task_events where task_id = ? order by seq
    `);

    const records = stmt.all(taskId);
    return records.map((record) =>
      this.mapTaskEventRecord(record as SQLiteTaskEventRecord),
    );
  }

  private async withRetry<T>(
    fn: () => T | Promise<T>,
    operation: string,
  ): Promise<T> {
    let lastError: Error | undefined;
    const { maxRetries, baseDelayMs, maxDelayMs } = DEFAULT_RETRY_CONFIG;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // check if error is retryable
        const isRetryable =
          lastError.message.includes("SQLITE_BUSY") ||
          lastError.message.includes("SQLITE_LOCKED");

        if (!isRetryable || attempt === maxRetries) {
          break;
        }

        // exponential backoff with jitter
        const delay = Math.min(
          baseDelayMs * 2 ** attempt + Math.random() * 100,
          maxDelayMs,
        );

        this.hooks.incrementCounter(TaskMetrics.REPOSITORY_RETRIES, 1, {
          [TaskAttributes.REPOSITORY_TYPE]: "sqlite",
          operation,
        });

        this.hooks?.log({
          severity: "warn",
          message: `SQLite operation failed, retrying`,
          attributes: {
            operation,
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
          },
          error: lastError,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.hooks?.incrementCounter(TaskMetrics.REPOSITORY_ERRORS, 1, {
      [TaskAttributes.REPOSITORY_TYPE]: "sqlite",
      [TaskAttributes.ERROR_TYPE]:
        lastError?.message.split(":")[0] ?? "unknown",
    });

    const isRetryable =
      lastError?.message.includes("SQLITE_BUSY") ||
      lastError?.message.includes("SQLITE_LOCKED");

    throw new RepositoryError(
      `SQLite ${operation} failed after ${maxRetries} retries`,
      "sqlite",
      operation === "executeBatch" ? "batch" : "query",
      isRetryable,
      lastError,
    );
  }

  /**
   * Insert a task event with deterministic entry_id
   * Uses the global event log seq for both entry_id hash and task_events.seq
   * This avoids expensive SELECT MAX(seq) query
   */
  private insertTaskEvent(
    taskId: string,
    type: EventLogEntryType,
    globalSeq: number,
    timestampMs: number,
    payload?: Record<string, unknown>,
  ): void {
    const hash = createHash("sha256")
      .update(`${taskId}:${globalSeq}`)
      .digest("hex");
    const entryId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;

    this.statements!.insertTaskEvent.run(
      entryId,
      taskId,
      globalSeq,
      type,
      new Date(timestampMs).toISOString(),
      payload ? JSON.stringify(payload) : null,
    );
  }

  private mapTaskRecord(record: SQLiteTaskRecord): Task {
    return Task.fromRecord({
      id: record.task_id,
      name: record.name,
      idempotency_key: record.idempotency_key,
      user_id: record.user_id,
      task_type: record.type as "background" | "user",
      status: record.status as TaskStatus,
      input: record.input_data ?? "{}",
      result: record.result,
      error: record.error,
      attempt: record.attempt,
      created_at: record.created_at,
      started_at: record.started_at,
      completed_at: record.completed_at,
      last_heartbeat_at: record.last_heartbeat_at,
      execution_options: record.execution_options,
    });
  }

  private mapTaskEventRecord(record: SQLiteTaskEventRecord): StoredEvent {
    return {
      id: record.entry_id,
      taskId: record.task_id,
      seq: record.seq,
      type: record.type as StoredEvent["type"],
      timestamp: new Date(record.timestamp),
      payload: record.payload ? JSON.parse(record.payload) : null,
    };
  }

  private async runMigrations(): Promise<void> {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.join(__dirname, "migrations");

    if (!fs.existsSync(migrationsFolder)) {
      // fallback, try to find migrations relative to the source
      const srcMigrationsFolder = path.resolve(
        process.cwd(),
        "packages/taskflow/src/persistence/repository/sqlite/migrations",
      );

      if (fs.existsSync(srcMigrationsFolder)) {
        const migrations = fs.readdirSync(srcMigrationsFolder).sort();
        for (const migration of migrations) {
          const migrationContent = fs.readFileSync(
            path.join(srcMigrationsFolder, migration),
            "utf8",
          );
          this.db.exec(migrationContent);
        }
        return;
      }

      throw new Error(
        `Migrations folder not found at ${migrationsFolder} or ${srcMigrationsFolder}`,
      );
    }

    const migrations = fs.readdirSync(migrationsFolder).sort();

    for (const migration of migrations) {
      const migrationContent = fs.readFileSync(
        path.join(migrationsFolder, migration),
        "utf8",
      );
      this.db.exec(migrationContent);
    }
  }
}

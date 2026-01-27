import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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
 * SQLite Connector
 *
 * Low-level SQLite operations for task persistence
 * Handles schema migrations, batch execution, and queries.
 */
export class SQLiteConnector {
  private db: Database.Database;
  private _isInitialized = false;
  private hooks: TaskSystemHooks;

  constructor(config: SQLiteConfig, hooks: TaskSystemHooks = noopHooks) {
    this.db = new Database(config.database ?? "./.taskflow/sqlite.db");
    this.hooks = hooks;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Initialize the database
   * Enables WAL mode and run migrations
   */
  async initialize(): Promise<void> {
    // enable WAL mode for better performance
    this.db.pragma("journal_mode = WAL");

    // run migrations
    await this.runMigrations();
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
   * Execute a batch of events in a transaction
   */
  async executeBatch(batch: EventLogEntry[]): Promise<void> {
    if (batch.length === 0) return;

    const startTime = Date.now();

    await this.withRetry(async () => {
      const transaction = this.db.transaction((entries: EventLogEntry[]) => {
        for (const entry of entries) {
          this.executeEntry(entry);
        }
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

  private executeEntry(entry: EventLogEntry): void {
    switch (entry.type) {
      case "TASK_CREATED":
        this.executeTaskCreated(entry);
        break;
      case "TASK_START":
        this.executeTaskStart(entry);
        break;
      case "TASK_COMPLETE":
        this.executeTaskComplete(entry);
        break;
      case "TASK_ERROR":
        this.executeTaskError(entry);
        break;
      case "TASK_PROGRESS":
        this.executeTaskProgress(entry);
        break;
      case "TASK_CANCELLED":
        this.executeTaskCancelled(entry);
        break;
      case "TASK_HEARTBEAT":
        this.executeTaskHeartbeat(entry);
        break;
      case "TASK_CUSTOM":
        this.executeTaskCustom(entry);
        break;
      default:
        throw new Error(`Unsupported event type: ${entry.type}`);
    }
  }

  private executeTaskCreated(entry: EventLogEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (task_id, name, status, type, idempotency_key, user_id, input_data, execution_options, created_at, last_heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
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

    this.insertTaskEvent(entry.taskId, "TASK_CREATED", entry.timestamp, {
      name: entry.name,
      taskType: entry.taskType,
      idempotencyKey: entry.idempotencyKey,
      userId: entry.userId,
      input: entry.input,
    });
  }

  private executeTaskStart(entry: EventLogEntry): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, started_at = ?, last_heartbeat_at = ? WHERE task_id = ?
    `);
    stmt.run(
      "running",
      new Date(entry.timestamp).toISOString(),
      new Date(entry.timestamp).toISOString(),
      entry.taskId,
    );

    this.insertTaskEvent(entry.taskId, "TASK_START", entry.timestamp);
  }

  private executeTaskComplete(entry: EventLogEntry): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, completed_at = ?, result = ? WHERE task_id = ?
    `);
    stmt.run(
      "completed",
      new Date(entry.timestamp).toISOString(),
      entry.result ? JSON.stringify(entry.result) : null,
      entry.taskId,
    );

    this.insertTaskEvent(entry.taskId, "TASK_COMPLETE", entry.timestamp, {
      result: entry.result,
    });
  }

  private executeTaskError(entry: EventLogEntry): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, completed_at = ?, error = ?, attempt = attempt + 1 WHERE task_id = ?
    `);
    stmt.run(
      "failed",
      new Date(entry.timestamp).toISOString(),
      entry.error ?? null,
      entry.taskId,
    );

    this.insertTaskEvent(entry.taskId, "TASK_ERROR", entry.timestamp, {
      error: entry.error,
    });
  }

  private executeTaskCancelled(entry: EventLogEntry): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, completed_at = ?, error = ? WHERE task_id = ?
    `);
    stmt.run(
      "cancelled",
      new Date(entry.timestamp).toISOString(),
      entry.error ?? null,
      entry.taskId,
    );

    this.insertTaskEvent(entry.taskId, "TASK_CANCELLED", entry.timestamp, {
      error: entry.error,
    });
  }

  private executeTaskProgress(entry: EventLogEntry): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET last_heartbeat_at = ? WHERE task_id = ?
    `);
    stmt.run(new Date(entry.timestamp).toISOString(), entry.taskId);

    this.insertTaskEvent(entry.taskId, "TASK_PROGRESS", entry.timestamp, {
      ...entry.payload,
    });
  }

  private executeTaskHeartbeat(entry: EventLogEntry): void {
    // only update heartbeat, do NOT insert into task_events
    const stmt = this.db.prepare(`
      UPDATE tasks SET last_heartbeat_at = ? WHERE task_id = ?
    `);
    stmt.run(new Date(entry.timestamp).toISOString(), entry.taskId);
  }

  private executeTaskCustom(entry: EventLogEntry): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET last_heartbeat_at = ? WHERE task_id = ?
    `);
    stmt.run(new Date(entry.timestamp).toISOString(), entry.taskId);

    this.insertTaskEvent(entry.taskId, "TASK_CUSTOM", entry.timestamp, {
      ...entry.payload,
    });
  }

  private insertTaskEvent(
    taskId: string,
    type: EventLogEntryType,
    timestampMs: number,
    payload?: Record<string, unknown>,
  ): void {
    // get next sequence number for this task
    const seqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 as nextSeq FROM task_events WHERE task_id = ?
    `);
    const { nextSeq } = seqStmt.get(taskId) as { nextSeq: number };

    const eventStmt = this.db.prepare(`
      INSERT INTO task_events (entry_id, task_id, seq, type, timestamp, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    eventStmt.run(
      crypto.randomUUID(),
      taskId,
      nextSeq,
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

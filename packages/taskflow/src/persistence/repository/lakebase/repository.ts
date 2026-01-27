import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import type { StoredEvent, TaskRepository } from "../types";
import type {
  LakebaseConnector,
  LakebaseRepositoryConfig,
  LakebaseTaskEventRecord,
  LakebaseTaskRecord,
  LakebaseTransactionClient,
} from "./types";

/**
 * Lakebase Task Repository
 *
 * Implements TaskRepository interface using Lakebase for storage
 * Consumer provides the connector
 */
export class LakebaseTaskRepository implements TaskRepository {
  readonly type = "lakebase" as const;
  private connector: LakebaseConnector;
  private _isInitialized = false;
  private hooks: TaskSystemHooks;

  constructor(
    config: LakebaseRepositoryConfig,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.connector = config.connector;
    this.hooks = hooks;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  async initialize(): Promise<void> {
    await this.runMigrations();
    this._isInitialized = true;

    this.hooks.log({
      severity: "info",
      message: "Lakebase repository initialized",
      attributes: {
        [TaskAttributes.REPOSITORY_TYPE]: "lakebase",
      },
    });
  }

  async close(): Promise<void> {
    await this.connector.close();
    this._isInitialized = false;
  }

  async executeBatch(entries: EventLogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const startTime = Date.now();

    try {
      await this.connector.transaction(
        async (client: LakebaseTransactionClient) => {
          for (const entry of entries) {
            await this.executeEntry(client, entry);
          }
        },
      );
      this.hooks?.incrementCounter(TaskMetrics.REPOSITORY_BATCH_EXECUTED, 1, {
        [TaskAttributes.REPOSITORY_TYPE]: "lakebase",
        [TaskAttributes.BATCH_SIZE]: entries.length,
      });

      this.hooks?.recordHistogram(
        TaskMetrics.REPOSITORY_BATCH_LATENCY_MS,
        Date.now() - startTime,
        { [TaskAttributes.REPOSITORY_TYPE]: "lakebase" },
      );
    } catch (error) {
      this.hooks?.incrementCounter(TaskMetrics.REPOSITORY_ERRORS, 1, {
        [TaskAttributes.REPOSITORY_TYPE]: "lakebase",
        operation: "batch",
      });

      throw new RepositoryError(
        "Failed to execute batch",
        "lakebase",
        "batch",
        true,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async findById(taskId: TaskId): Promise<Task | null> {
    const result = await this.connector.query<LakebaseTaskRecord>(
      "SELECT * FROM tasks WHERE task_id = $1",
      [taskId],
    );
    return result.rows[0] ? this.mapTaskRecord(result.rows[0]) : null;
  }

  async findByIdempotencyKey(
    idempotencyKey: IdempotencyKey,
  ): Promise<Task | null> {
    const result = await this.connector.query<LakebaseTaskRecord>(
      "SELECT * FROM tasks WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    return result.rows[0] ? this.mapTaskRecord(result.rows[0]) : null;
  }

  async findStaleTasks(threshold: number): Promise<Task[]> {
    const thresholdDateMs = new Date(Date.now() - threshold).toISOString();
    const result = await this.connector.query<LakebaseTaskRecord>(
      "SELECT * FROM tasks WHERE status = 'running' AND last_heartbeat_at < $1",
      [thresholdDateMs],
    );
    return result.rows.map((row) => this.mapTaskRecord(row));
  }

  async getEvents(taskId: TaskId): Promise<StoredEvent[]> {
    const result = await this.connector.query<LakebaseTaskEventRecord>(
      "SELECT * FROM task_events WHERE task_id = $1 ORDER BY seq",
      [taskId],
    );
    return result.rows.map((row) => this.mapTaskEventRecord(row));
  }

  async healthCheck(): Promise<boolean> {
    return this.connector.healthCheck();
  }

  private async runMigrations(): Promise<void> {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.join(__dirname, "migrations");

    if (!fs.existsSync(migrationsFolder)) {
      // fallback for test environment
      const srcMigrationsFolder = path.resolve(
        process.cwd(),
        "packages/taskflow/src/persistence/repository/lakebase/migrations",
      );

      if (fs.existsSync(srcMigrationsFolder)) {
        const migrations = fs.readdirSync(srcMigrationsFolder).sort();
        for (const migration of migrations) {
          const migrationContent = fs.readFileSync(
            path.join(srcMigrationsFolder, migration),
            "utf8",
          );
          await this.connector.query(migrationContent);
        }
        return;
      }

      throw new RepositoryError(
        `Migrations folder not found at ${migrationsFolder} or ${srcMigrationsFolder}`,
        "lakebase",
        "migration",
      );
    }

    const migrations = fs.readdirSync(migrationsFolder).sort();

    for (const migration of migrations) {
      try {
        const migrationContent = fs.readFileSync(
          path.join(migrationsFolder, migration),
          "utf8",
        );
        await this.connector.query(migrationContent);

        this.hooks?.log({
          severity: "info",
          message: "Applied migration",
          attributes: {
            [TaskAttributes.MIGRATION_NAME]: migration,
            [TaskAttributes.REPOSITORY_TYPE]: "lakebase",
          },
        });
      } catch (error) {
        throw new RepositoryError(
          `Failed to apply migration ${migration}`,
          "lakebase",
          "migration",
          false,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private async executeEntry(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    switch (entry.type) {
      case "TASK_CREATED":
        await this.executeTaskCreated(client, entry);
        break;
      case "TASK_START":
        await this.executeTaskStart(client, entry);
        break;
      case "TASK_COMPLETE":
        await this.executeTaskComplete(client, entry);
        break;
      case "TASK_ERROR":
        await this.executeTaskError(client, entry);
        break;
      case "TASK_PROGRESS":
        await this.executeTaskProgress(client, entry);
        break;
      case "TASK_CANCELLED":
        await this.executeTaskCancelled(client, entry);
        break;
      case "TASK_HEARTBEAT":
        await this.executeTaskHeartbeat(client, entry);
        break;
      case "TASK_CUSTOM":
        await this.executeTaskCustom(client, entry);
        break;
      default:
        throw new Error(`Unknown entry type: ${entry.type}`);
    }
  }

  private async executeTaskCreated(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    await client.query(
      `INSERT INTO tasks (task_id, name, status, type, idempotency_key, user_id, input_data, execution_options, created_at, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
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
      ],
    );
    await this.insertTaskEvent(
      client,
      entry.taskId,
      "TASK_CREATED",
      entry.timestamp,
      {
        name: entry.name,
        taskType: entry.taskType,
        idempotencyKey: entry.idempotencyKey,
        userId: entry.userId,
        input: entry.input,
      },
    );
  }

  private async executeTaskStart(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    await client.query(
      `UPDATE tasks SET status = $1, started_at = $2, last_heartbeat_at = $3 WHERE task_id = $4`,
      [
        "running",
        new Date(entry.timestamp).toISOString(),
        new Date(entry.timestamp).toISOString(),
        entry.taskId,
      ],
    );
    await this.insertTaskEvent(
      client,
      entry.taskId,
      "TASK_START",
      entry.timestamp,
    );
  }

  private async executeTaskComplete(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    await client.query(
      `UPDATE tasks SET status = $1, completed_at = $2, result = $3 WHERE task_id = $4`,
      [
        "completed",
        new Date(entry.timestamp).toISOString(),
        entry.result ? JSON.stringify(entry.result) : null,
        entry.taskId,
      ],
    );
    await this.insertTaskEvent(
      client,
      entry.taskId,
      "TASK_COMPLETE",
      entry.timestamp,
      {
        result: entry.result,
      },
    );
  }

  private async executeTaskError(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    await client.query(
      `UPDATE tasks SET status = $1, completed_at = $2, error = $3, attempt = attempt + 1 WHERE task_id = $4`,
      [
        "failed",
        new Date(entry.timestamp).toISOString(),
        entry.error ?? null,
        entry.taskId,
      ],
    );
    await this.insertTaskEvent(
      client,
      entry.taskId,
      "TASK_ERROR",
      entry.timestamp,
      {
        error: entry.error,
      },
    );
  }

  private async executeTaskCancelled(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    await client.query(
      `UPDATE tasks SET status = $1, completed_at = $2, error = $3 WHERE task_id = $4`,
      [
        "cancelled",
        new Date(entry.timestamp).toISOString(),
        entry.error ?? null,
        entry.taskId,
      ],
    );
    await this.insertTaskEvent(
      client,
      entry.taskId,
      "TASK_CANCELLED",
      entry.timestamp,
      {
        error: entry.error,
      },
    );
  }

  private async executeTaskProgress(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    await client.query(
      `UPDATE tasks SET last_heartbeat_at = $1 WHERE task_id = $2`,
      [new Date(entry.timestamp).toISOString(), entry.taskId],
    );
    await this.insertTaskEvent(
      client,
      entry.taskId,
      "TASK_PROGRESS",
      entry.timestamp,
      {
        ...entry.payload,
      },
    );
  }

  private async executeTaskHeartbeat(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    // only update heartbeat, do NOT insert into task_events
    await client.query(
      `UPDATE tasks SET last_heartbeat_at = $1 WHERE task_id = $2`,
      [new Date(entry.timestamp).toISOString(), entry.taskId],
    );
  }

  private async executeTaskCustom(
    client: LakebaseTransactionClient,
    entry: EventLogEntry,
  ): Promise<void> {
    await client.query(
      `UPDATE tasks SET last_heartbeat_at = $1 WHERE task_id = $2`,
      [new Date(entry.timestamp).toISOString(), entry.taskId],
    );
    await this.insertTaskEvent(
      client,
      entry.taskId,
      "TASK_CUSTOM",
      entry.timestamp,
      {
        ...entry.payload,
      },
    );
  }

  private async insertTaskEvent(
    client: LakebaseTransactionClient,
    taskId: string,
    type: EventLogEntryType,
    timestampMs: number,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    // get next sequence number
    const seqResult = await client.query<{ nextseq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 as nextseq FROM task_events WHERE task_id = $1`,
      [taskId],
    );
    const nextSeq = seqResult.rows[0]?.nextseq ?? 1;

    await client.query(
      `INSERT INTO task_events (entry_id, task_id, seq, type, timestamp, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        taskId,
        nextSeq,
        type,
        new Date(timestampMs).toISOString(),
        payload ? JSON.stringify(payload) : null,
      ],
    );
  }

  private mapTaskRecord(record: LakebaseTaskRecord): Task {
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

  private mapTaskEventRecord(record: LakebaseTaskEventRecord): StoredEvent {
    return {
      id: record.entry_id,
      taskId: record.task_id,
      seq: record.seq,
      type: record.type as StoredEvent["type"],
      timestamp: new Date(record.timestamp),
      payload: record.payload ? JSON.parse(record.payload) : null,
    };
  }
}

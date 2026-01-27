import type { IdempotencyKey, TaskId } from "@/core/branded";
import type { EventLogEntry, Task } from "@/domain";
import {
  noopHooks,
  TaskAttributes,
  type TaskSystemHooks,
} from "@/observability";
import type { StoredEvent, TaskRepository } from "../types";
import { SQLiteConnector } from "./connector";
import type { SQLiteRepositoryConfig } from "./types";

/**
 * SQLite Task Repository
 *
 * Implements TaskRepository interface using SQLite for storage
 */
export class SQLiteTaskRepository implements TaskRepository {
  readonly type = "sqlite" as const;
  private connector: SQLiteConnector;
  private hooks: TaskSystemHooks;

  constructor(
    config: SQLiteRepositoryConfig,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.connector = new SQLiteConnector(
      {
        database: config.database ?? "./.taskflow/sqlite.db",
      },
      hooks,
    );
    this.hooks = hooks;
  }

  get isInitialized(): boolean {
    return this.connector.isInitialized;
  }

  async initialize(): Promise<void> {
    await this.connector.initialize();

    this.hooks.log({
      severity: "info",
      message: "SQLite repository initialized",
      attributes: {
        [TaskAttributes.REPOSITORY_TYPE]: "sqlite",
      },
    });
  }

  async executeBatch(entries: EventLogEntry[]): Promise<void> {
    await this.connector.executeBatch(entries);
  }

  async findById(taskId: TaskId): Promise<Task | null> {
    return this.connector.findTaskById(taskId);
  }

  async findByIdempotencyKey(
    idempotencyKey: IdempotencyKey,
  ): Promise<Task | null> {
    return this.connector.findTaskByIdempotencyKey(idempotencyKey);
  }

  async findStaleTasks(staleThresholdMs: number): Promise<Task[]> {
    return this.connector.findStaleTasks(staleThresholdMs);
  }

  async getEvents(taskId: TaskId): Promise<StoredEvent[]> {
    return this.connector.getTaskEvents(taskId);
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.connector.findTaskById("__health__check__" as TaskId);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.connector.close();
  }
}

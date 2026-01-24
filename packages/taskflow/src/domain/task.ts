import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { TaskStateError } from "@/core/errors";
import {
  isTerminalStatus,
  type TaskStatus,
  type TaskType,
  VALID_TRANSITIONS,
} from "@/core/types";
import type {
  TaskCreationParams,
  TaskExecutionOptions,
  TaskJSON,
  TaskRecord,
} from "./types";

/**
 * Task entity representing a unit of work in the task system
 *
 * State Machine:
 * - created -> running -> completed
 * - created -> running -> failed
 * - created -> running -> cancelled
 * - created -> cancelled
 * - failed -> created (via resetToPending)
 */
export class Task {
  /** Unique task identifier */
  readonly id: string;
  /** Task name/template */
  readonly name: string;
  /** Input data for the handler */
  readonly input: unknown;
  /** User ID (null for background tasks) */
  readonly userId: string | null;
  /** Idempotency key for deduplication */
  readonly idempotencyKey: string;
  /** Creation timestamp */
  readonly createdAt: Date;
  /** Task type: user or background */
  readonly type: TaskType;
  /** Execution options */
  readonly executionOptions?: TaskExecutionOptions;

  /** Mutable internal state */
  private _status: TaskStatus;
  private _startedAt?: Date;
  private _completedAt?: Date;
  private _lastHeartbeatAt?: Date;
  private _attempt: number;
  private _result?: unknown;
  private _error?: string;

  /** Current task status */
  get status(): TaskStatus {
    return this._status;
  }

  /** When the task started executing */
  get startedAt(): Date | undefined {
    return this._startedAt;
  }

  /** When the task completed (success, failure or cancellation) */
  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  /** Last heartbeat timestamp (for stale detection) */
  get lastHeartbeatAt(): Date | undefined {
    return this._lastHeartbeatAt;
  }

  /** Current attempt number (1-indexed when running) */
  get attempt(): number {
    return this._attempt;
  }

  /** Task result (when completed successfully) */
  get result(): unknown | undefined {
    return this._result;
  }

  /** Error message (when failed) */
  get error(): string | undefined {
    return this._error;
  }

  /** Duration in milliseconds (if started) */
  get durationMs(): number | undefined {
    if (!this._startedAt) return undefined;
    const endTime = this._completedAt ?? new Date();
    return endTime.getTime() - this._startedAt.getTime();
  }

  /** Whether the task is in a terminal state */
  get isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  /** Whether the task is currently running */
  get isRunning(): boolean {
    return this._status === "running";
  }

  constructor(params: TaskCreationParams) {
    this.id = crypto.randomUUID();
    this.name = params.name;
    this.input = params.input;
    this.userId = params.userId;
    this.type = params.type ?? "user";
    this.executionOptions = params.executionOptions;
    this.createdAt = new Date();
    this._status = "created";
    this._attempt = 0;

    this.idempotencyKey =
      params.idempotencyKey ?? Task.generateIdempotencyKey(params);
  }

  /**
   * Transition to running state
   * @throws {TaskStateError} if transition is invalid
   */
  start(): void {
    this.assertNotTerminal("start");
    this.assertStatus(["created"], "start");

    this._status = "running";
    this._startedAt = new Date();
    this._lastHeartbeatAt = new Date();
    this._attempt++;
  }

  /**
   * Transition to completed state
   * @param result Optional result data
   * @throws {TaskStateError} if transition is invalid
   */
  complete(result?: unknown): void {
    this.assertNotTerminal("complete");
    this.assertStatus(["running"], "complete");

    this._status = "completed";
    this._completedAt = new Date();
    this._result = result;
  }

  /**
   * Transition to failed state
   * @param error Error message or error object
   * @throws {TaskStateError} if transition is invalid
   */
  fail(error: string | Error): void {
    this.assertNotTerminal("fail");
    this.assertStatus(["running"], "fail");

    this._status = "failed";
    this._completedAt = new Date();
    this._error =
      error instanceof Error ? error.message : (error ?? "Unknown error");
  }

  /**
   * Transition to cancelled state
   * @param reason Optional cancellation reason
   * @throws {TaskStateError} if transition is invalid
   */
  cancel(reason?: string): void {
    this.assertNotTerminal("cancel");
    this.assertStatus(["created", "running"], "cancel");

    this._status = "cancelled";
    this._completedAt = new Date();
    this._error = reason ?? "Task cancelled";
  }

  /**
   * Record a heartbeat (updates lastHeartbeatAt)
   * @throws {TaskStateError} if task is not running
   */
  recordHeartbeat(): void {
    this.assertStatus(["running"], "recordHeartbeat");
    this._lastHeartbeatAt = new Date();
  }

  /**
   * Increment the attempt counter (for retries)
   * @throws {TaskStateError} if task is not running
   */
  incrementAttempt(): void {
    this.assertStatus(["running"], "incrementAttempt");
    this._attempt++;
  }

  /**
   * Reset a failed task back to created state for retry
   * @throws {TaskStateError} if task is not in failed state
   */
  resetToPending(): void {
    this.assertStatus(["failed"], "resetToPending");

    this._status = "created";
    this._completedAt = undefined;
    this._error = undefined;
  }

  /**
   * Serialize task to JSON-compatible object
   */
  toJSON(): TaskJSON {
    const json: TaskJSON = {
      id: this.id,
      name: this.name,
      input: this.input,
      userId: this.userId,
      idempotencyKey: this.idempotencyKey,
      type: this.type,
      status: this._status,
      attempt: this._attempt,
      createdAt: this.createdAt.toISOString(),
    };

    if (this._result) json.result = this._result;
    if (this._error) json.error = this._error;
    if (this._startedAt) json.startedAt = this._startedAt.toISOString();
    if (this._completedAt) json.completedAt = this._completedAt.toISOString();
    if (this._lastHeartbeatAt)
      json.lastHeartbeatAt = this._lastHeartbeatAt.toISOString();
    if (this._startedAt !== undefined) {
      const duration = this.durationMs;
      if (duration !== undefined) json.durationMs = duration;
    }
    if (this.executionOptions) json.executionOptions = this.executionOptions;

    return json;
  }

  /**
   * Reconstruct a Task from a database record
   */
  static fromRecord(record: TaskRecord): Task {
    const task = new Task({
      name: record.name,
      input: JSON.parse(record.input),
      userId: record.user_id,
      type: record.task_type as TaskType,
      idempotencyKey: record.idempotency_key,
      executionOptions: record.execution_options
        ? JSON.parse(record.execution_options)
        : undefined,
    });

    // override readonly properties via Object.defineProperty
    Object.defineProperty(task, "id", { value: record.id });
    Object.defineProperty(task, "createdAt", {
      value: new Date(record.created_at),
    });

    // restore mutable state
    task._status = record.status;
    task._attempt = record.attempt;

    if (record.started_at) task._startedAt = new Date(record.started_at);
    if (record.completed_at) task._completedAt = new Date(record.completed_at);
    if (record.last_heartbeat_at)
      task._lastHeartbeatAt = new Date(record.last_heartbeat_at);
    if (record.result) task._result = JSON.parse(record.result);
    task._error = record.error ?? undefined;

    return task;
  }

  /**
   * Generate a deterministic idempotency key from task parameters
   * Uses json-canonicalize fro consistent key ordering
   */
  static generateIdempotencyKey(params: TaskCreationParams): string {
    const payload = {
      name: params.name,
      input: params.input,
      userId: params.userId,
    };
    return createHash("sha256").update(canonicalize(payload)).digest("hex");
  }

  /**
   * Assert that the task is not in a terminal state
   * @throws {TaskStateError} if task is terminal
   */
  private assertNotTerminal(action: string): void {
    if (this.isTerminal) {
      throw new TaskStateError(
        `Cannot ${action} a terminal task`,
        this._status,
        undefined,
        VALID_TRANSITIONS[this._status],
      );
    }
  }

  /**
   * Assert that the task is one of the allowed states
   * @throws {TaskStateError} if task is not in the allowed states
   */
  private assertStatus(allowed: TaskStatus[], action: string): void {
    if (!allowed.includes(this._status)) {
      throw new TaskStateError(
        `Cannot ${action} from state ${this._status}, allowed: ${allowed.join(", ")}`,
        this._status,
        undefined,
        allowed,
      );
    }
  }
}

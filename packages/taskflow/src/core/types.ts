/**
 * Core types for the task system
 */

/**
 * Represents the lifecycle status of a task.
 *
 * State Machine:
 * - created -> running -> completed
 * - created -> running -> failed
 * - created -> running -> cancelled
 * - created -> cancelled
 * - failed -> created (via resetToPending)
 */
export type TaskStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Represents the type of task execution.
 * - "user": User-initiated tasks that support real-time streaming
 * - "background": Background tasks that run without a connected client
 */
export type TaskType = "user" | "background";

/**
 * Valid state transitions for the task state machine.
 * Used for validation in Task.ts
 */
export const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["created"], // resetted
  cancelled: [],
};

/**
 * Checks if a transition from one status to another is valid.
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to);
}

/**
 * Check if a status is terminal (no further transitions possible except reset)
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

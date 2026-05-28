/**
 * @public
 * Durable execution. Enabled by passing `task: true` or an explicit task
 * config to `createApp`; exposed to plugins as `this.task`.
 */

export type {
  ResumeOptions,
  StopOptions,
  StreamEvent,
  SubmitOptions,
  Task,
  TaskContext,
  TaskEvent,
  TaskHandle,
} from "../../vendor/taskflow/taskflow.js";
export type { TaskConfig, TaskOption } from "./defaults";
export {
  type ExecuteTaskSettings,
  executeTask,
  TASK_IDEMPOTENCY_HEADER,
} from "./execute-task";
export { TaskManager } from "./manager";
export { type SseEvent, setupSseHeaders, writeSseFrame } from "./sse";
export { step } from "./step";
export type { TaskDefinition, TaskRef, TypedTaskContext } from "./types";

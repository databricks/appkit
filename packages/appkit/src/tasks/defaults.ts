import type { TaskflowConfig as VendorTaskConfig } from "../../vendor/taskflow/taskflow.js";

export type TaskConfig = VendorTaskConfig;
export type TaskOption = true | TaskConfig | false | undefined;

/** AppKit defaults; paths live under `.appkit/tasks/`. */
export const taskDefaults: TaskConfig = {
  engine: {
    walPath: ".appkit/tasks/wal",
    recoveryIntervalMs: 5000,
    staleThresholdMs: 30000,
    enableTestMode: false,
  },
  executor: {
    heartbeatIntervalMs: 5000,
  },
  storage: {
    backend: "sqlite",
    databasePath: ".appkit/tasks/tasks.db",
  },
};

/** Merges AppKit defaults with user config; explicit user fields win. */
export function mergeTaskDefaults(
  user: true | TaskConfig | undefined,
): TaskConfig {
  if (!user || user === true) return taskDefaults;
  const merged: TaskConfig = {
    ...taskDefaults,
    ...user,
    engine: { ...taskDefaults.engine, ...user.engine },
    executor: { ...taskDefaults.executor, ...user.executor },
    storage: user.storage ?? taskDefaults.storage,
  };
  if (user.wal) merged.wal = { ...user.wal };
  if (user.admission) merged.admission = { ...user.admission };
  if (user.stream) merged.stream = { ...user.stream };
  return merged;
}

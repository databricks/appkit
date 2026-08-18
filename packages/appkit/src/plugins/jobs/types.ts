import type { BasePluginConfig } from "shared";
import type { z } from "zod";

import type { ExecutionResult } from "../../plugin";
import type { jobs } from "../../workspace-client";

/** Supported task types for job parameter mapping. */
export type TaskType =
  | "notebook"
  | "python_wheel"
  | "python_script"
  | "spark_jar"
  | "sql"
  | "dbt";

/** Per-job configuration options. */
export interface JobConfig {
  /** Maximum time (ms) to poll in runAndWait before giving up. Defaults to 600 000 (10 min). */
  waitTimeout?: number;
  /** The type of task this job runs. Determines how params are mapped to the SDK request. */
  taskType?: TaskType;
  /** Optional Zod schema for validating job parameters at runtime. */
  params?: z.ZodType<Record<string, unknown>>;
}

/** Status update yielded by runAndWait during polling. */
export interface JobRunStatus {
  status: string | undefined;
  timestamp: number;
  run: jobs.Run;
}

/** User-facing API for a single configured job. */
export interface JobAPI {
  /** Trigger the configured job with validated params. Returns the run response. */
  runNow(
    params?: Record<string, unknown>,
  ): Promise<ExecutionResult<jobs.RunNowResponse>>;
  /** Trigger and poll until completion, yielding status updates. */
  runAndWait(
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<JobRunStatus, void, unknown>;
  /** Get the most recent run for this job. */
  lastRun(): Promise<ExecutionResult<jobs.BaseRun | undefined>>;
  /** List runs for this job. */
  listRuns(options?: {
    limit?: number;
  }): Promise<ExecutionResult<jobs.BaseRun[]>>;
  /** Get a specific run by ID. */
  getRun(runId: number): Promise<ExecutionResult<jobs.Run>>;
  /** Get output of a specific run. */
  getRunOutput(runId: number): Promise<ExecutionResult<jobs.RunOutput>>;
  /** Cancel a specific run. */
  cancelRun(runId: number): Promise<ExecutionResult<void>>;
  /** Get the job definition. */
  getJob(): Promise<ExecutionResult<jobs.Job>>;
}

/** Configuration for the Jobs plugin. */
export interface IJobsConfig extends BasePluginConfig {
  /** Operation timeout in milliseconds. Defaults to 60000. */
  timeout?: number;
  /** Poll interval for waitForRun in milliseconds. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Named jobs to expose. Each key becomes a job accessor. */
  jobs?: Record<string, JobConfig>;
}

/**
 * Public API shape of the jobs plugin.
 * Callable to select a job by key.
 *
 * @example
 * ```ts
 * // Trigger a configured job
 * const { run_id } = await appkit.jobs("etl").runNow();
 *
 * // Trigger and poll until completion
 * for await (const status of appkit.jobs("etl").runAndWait()) {
 *   console.log(status.status, status.run);
 * }
 * ```
 */
export type JobsExport = (jobKey: string) => JobAPI;

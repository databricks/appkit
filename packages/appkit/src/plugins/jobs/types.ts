import type { jobs } from "@databricks/sdk-experimental";
import type { BasePluginConfig, IAppRequest } from "shared";

/** Per-job configuration options. */
export interface JobConfig {
  /** Override timeout for this specific job. */
  timeout?: number;
}

/** User-facing API for a single configured job. */
export interface JobAPI {
  /** Trigger the configured job. Returns the run ID. */
  runNow(params?: jobs.RunNow): Promise<jobs.RunNowResponse>;
  /** Trigger and wait for completion. */
  runNowAndWait(
    params?: jobs.RunNow,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<jobs.Run>;
  /** Get the most recent run for this job. */
  lastRun(): Promise<jobs.Run | undefined>;
  /** List runs for this job. */
  listRuns(options?: { limit?: number }): Promise<jobs.BaseRun[]>;
  /** Get a specific run by ID. */
  getRun(runId: number): Promise<jobs.Run>;
  /** Get output of a specific run. */
  getRunOutput(runId: number): Promise<jobs.RunOutput>;
  /** Cancel a specific run. */
  cancelRun(runId: number): Promise<void>;
  /** Get the job definition. */
  getJob(): Promise<jobs.Job>;
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
 * Job handle returned by `appkit.jobs("etl")`.
 * Supports OBO access via `.asUser(req)`.
 */
export type JobHandle = JobAPI & {
  asUser: (req: IAppRequest) => JobAPI;
};

/**
 * Public API shape of the jobs plugin.
 * Callable to select a job, with a `.job()` alias.
 *
 * @example
 * ```ts
 * // Trigger a configured job
 * const { run_id } = await appkit.jobs("etl").runNow();
 *
 * // Trigger and wait for completion
 * const run = await appkit.jobs("etl").runNowAndWait();
 *
 * // OBO access
 * await appkit.jobs("etl").asUser(req).runNow();
 *
 * // Named accessor
 * const job = appkit.jobs.job("etl");
 * await job.runNow();
 * ```
 */
export interface JobsExport {
  (jobKey: string): JobHandle;
  job: (jobKey: string) => JobHandle;
}

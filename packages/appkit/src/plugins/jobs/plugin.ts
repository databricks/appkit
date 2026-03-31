import type { jobs as jobsTypes } from "@databricks/sdk-experimental";
import { JobsConnector } from "../../connectors/jobs";
import { getWorkspaceClient } from "../../context";
import { InitializationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import manifest from "./manifest.json";
import type { IJobsConfig } from "./types";

const logger = createLogger("jobs");

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_WAIT_TIMEOUT = 600_000;

/**
 * AppKit plugin for Databricks Jobs API.
 *
 * Provides typed methods for submitting, monitoring, and managing job runs,
 * integrated with AppKit's telemetry, error handling, and interceptor chain.
 *
 * @example
 * ```ts
 * import { createApp, jobs, server } from "@databricks/appkit";
 *
 * const AppKit = await createApp({
 *   plugins: [server(), jobs()],
 * });
 *
 * // Submit a one-time run
 * const { run_id } = await AppKit.jobs.submitRun({
 *   run_name: "my-analysis",
 *   tasks: [{
 *     task_key: "main",
 *     notebook_task: { notebook_path: "/Users/me/analysis" },
 *   }],
 * });
 *
 * // Wait for completion
 * const run = await AppKit.jobs.waitForRun(run_id);
 * console.log(run.state?.result_state); // "SUCCESS"
 * ```
 */
export class JobsPlugin extends Plugin {
  static manifest = manifest as PluginManifest<"jobs">;

  protected declare config: IJobsConfig;
  private connector: JobsConnector;
  private readonly defaultTimeout: number;

  constructor(config: IJobsConfig) {
    super(config);
    this.config = config;
    this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.connector = new JobsConnector({
      timeout: this.defaultTimeout,
      telemetry: config.telemetry,
    });
  }

  async setup() {
    const client = getWorkspaceClient();
    if (!client) {
      throw new InitializationError(
        "Jobs plugin requires a configured workspace client",
      );
    }
    logger.info("Jobs plugin initialized");
  }

  private get executeOptions() {
    return { timeout: this.defaultTimeout };
  }

  /**
   * Submits a one-time run without creating a job.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/submit
   */
  async submitRun(
    request: jobsTypes.SubmitRun,
    signal?: AbortSignal,
  ): Promise<jobsTypes.SubmitRunResponse> {
    return this.execute(
      (sig) =>
        this.connector.submitRun(getWorkspaceClient(), request, sig ?? signal),
      this.executeOptions,
    ) as Promise<jobsTypes.SubmitRunResponse>;
  }

  /**
   * Triggers a run of an existing job.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/run-now
   */
  async runNow(
    request: jobsTypes.RunNow,
    signal?: AbortSignal,
  ): Promise<jobsTypes.RunNowResponse> {
    return this.execute(
      (sig) =>
        this.connector.runNow(getWorkspaceClient(), request, sig ?? signal),
      this.executeOptions,
    ) as Promise<jobsTypes.RunNowResponse>;
  }

  /**
   * Retrieves metadata of a run.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/get-run
   */
  async getRun(runId: number, signal?: AbortSignal): Promise<jobsTypes.Run> {
    return this.execute(
      (sig) =>
        this.connector.getRun(
          getWorkspaceClient(),
          { run_id: runId },
          sig ?? signal,
        ),
      this.executeOptions,
    ) as Promise<jobsTypes.Run>;
  }

  /**
   * Retrieves output of a single task run.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/get-run-output
   */
  async getRunOutput(
    runId: number,
    signal?: AbortSignal,
  ): Promise<jobsTypes.RunOutput> {
    return this.execute(
      (sig) =>
        this.connector.getRunOutput(
          getWorkspaceClient(),
          { run_id: runId },
          sig ?? signal,
        ),
      this.executeOptions,
    ) as Promise<jobsTypes.RunOutput>;
  }

  /**
   * Cancels a job run.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/cancel-run
   */
  async cancelRun(runId: number, signal?: AbortSignal): Promise<void> {
    await this.execute(
      (sig) =>
        this.connector.cancelRun(
          getWorkspaceClient(),
          { run_id: runId },
          sig ?? signal,
        ),
      this.executeOptions,
    );
  }

  /**
   * Lists runs for a job.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/list-runs
   */
  async listRuns(
    request: jobsTypes.ListRunsRequest,
    signal?: AbortSignal,
  ): Promise<jobsTypes.BaseRun[]> {
    return this.execute(
      (sig) =>
        this.connector.listRuns(getWorkspaceClient(), request, sig ?? signal),
      this.executeOptions,
    ) as Promise<jobsTypes.BaseRun[]>;
  }

  /**
   * Retrieves details for a single job.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/get
   */
  async getJob(jobId: number, signal?: AbortSignal): Promise<jobsTypes.Job> {
    return this.execute(
      (sig) =>
        this.connector.getJob(
          getWorkspaceClient(),
          { job_id: jobId },
          sig ?? signal,
        ),
      this.executeOptions,
    ) as Promise<jobsTypes.Job>;
  }

  /**
   * Creates a new job.
   *
   * @see https://docs.databricks.com/api/workspace/jobs/create
   */
  async createJob(
    request: jobsTypes.CreateJob,
    signal?: AbortSignal,
  ): Promise<jobsTypes.CreateResponse> {
    return this.execute(
      (sig) =>
        this.connector.createJob(getWorkspaceClient(), request, sig ?? signal),
      this.executeOptions,
    ) as Promise<jobsTypes.CreateResponse>;
  }

  /**
   * Polls a run until it reaches a terminal state (TERMINATED, SKIPPED, or INTERNAL_ERROR).
   */
  async waitForRun(
    runId: number,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<jobsTypes.Run> {
    return this.connector.waitForRun(
      getWorkspaceClient(),
      runId,
      this.config.pollIntervalMs ?? 5000,
      options?.timeoutMs ?? this.config.timeout ?? DEFAULT_WAIT_TIMEOUT,
      options?.signal,
    );
  }

  exports() {
    return {
      submitRun: this.submitRun.bind(this),
      runNow: this.runNow.bind(this),
      getRun: this.getRun.bind(this),
      getRunOutput: this.getRunOutput.bind(this),
      cancelRun: this.cancelRun.bind(this),
      listRuns: this.listRuns.bind(this),
      getJob: this.getJob.bind(this),
      createJob: this.createJob.bind(this),
      waitForRun: this.waitForRun.bind(this),
    };
  }
}

/**
 * @internal
 */
export const jobs = toPlugin(JobsPlugin);

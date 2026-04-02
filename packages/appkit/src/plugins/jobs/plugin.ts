import type { jobs as jobsTypes } from "@databricks/sdk-experimental";
import type { IAppRequest } from "shared";
import { JobsConnector } from "../../connectors/jobs";
import { getWorkspaceClient } from "../../context";
import { InitializationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest, ResourceRequirement } from "../../registry";
import { ResourceType } from "../../registry";
import manifest from "./manifest.json";
import type {
  IJobsConfig,
  JobAPI,
  JobConfig,
  JobHandle,
  JobsExport,
} from "./types";

const logger = createLogger("jobs");

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_WAIT_TIMEOUT = 600_000;
const DEFAULT_POLL_INTERVAL = 5_000;

class JobsPlugin extends Plugin {
  static manifest = manifest as PluginManifest;

  protected declare config: IJobsConfig;
  private connector: JobsConnector;
  private jobIds: Record<string, number> = {};
  private jobKeys: string[] = [];

  /**
   * Scans process.env for DATABRICKS_JOB_* keys and merges with explicit config.
   * Explicit config wins for per-job overrides; auto-discovered jobs get default `{}` config.
   */
  static discoverJobs(config: IJobsConfig): Record<string, JobConfig> {
    const explicit = config.jobs ?? {};
    const discovered: Record<string, JobConfig> = {};

    const prefix = "DATABRICKS_JOB_";
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith(prefix)) continue;
      if (key === "DATABRICKS_JOB_ID") continue;
      const suffix = key.slice(prefix.length);
      if (!suffix || !process.env[key]) continue;
      const jobKey = suffix.toLowerCase();
      if (!(jobKey in explicit)) {
        discovered[jobKey] = {};
      }
    }

    // Single-job shorthand: DATABRICKS_JOB_ID maps to "default" key
    if (
      process.env.DATABRICKS_JOB_ID &&
      Object.keys(explicit).length === 0 &&
      Object.keys(discovered).length === 0
    ) {
      discovered["default"] = {};
    }

    return { ...discovered, ...explicit };
  }

  /**
   * Generates resource requirements dynamically from discovered + configured jobs.
   * Each job key maps to a `DATABRICKS_JOB_{KEY_UPPERCASE}` env var (or `DATABRICKS_JOB_ID` for "default").
   */
  static getResourceRequirements(config: IJobsConfig): ResourceRequirement[] {
    const jobs = JobsPlugin.discoverJobs(config);
    return Object.keys(jobs).map((key) => ({
      type: ResourceType.JOB,
      alias: `job-${key}`,
      resourceKey: `job-${key}`,
      description: `Databricks Job "${key}"`,
      permission: "CAN_MANAGE_RUN" as const,
      fields: {
        id: {
          env:
            key === "default"
              ? "DATABRICKS_JOB_ID"
              : `DATABRICKS_JOB_${key.toUpperCase()}`,
          description: `Job ID for "${key}"`,
        },
      },
      required: true,
    }));
  }

  constructor(config: IJobsConfig) {
    super(config);
    this.config = config;
    this.connector = new JobsConnector({
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      telemetry: config.telemetry,
    });

    const jobs = JobsPlugin.discoverJobs(config);
    this.jobKeys = Object.keys(jobs);

    for (const key of this.jobKeys) {
      const envVar =
        key === "default"
          ? "DATABRICKS_JOB_ID"
          : `DATABRICKS_JOB_${key.toUpperCase()}`;
      const jobIdStr = process.env[envVar];
      if (jobIdStr) {
        const parsed = parseInt(jobIdStr, 10);
        if (!isNaN(parsed)) {
          this.jobIds[key] = parsed;
        }
      }
    }
  }

  async setup() {
    const client = getWorkspaceClient();
    if (!client) {
      throw new InitializationError(
        "Jobs plugin requires a configured workspace client",
      );
    }

    if (this.jobKeys.length === 0) {
      logger.warn(
        "No jobs configured. Set DATABRICKS_JOB_ID or DATABRICKS_JOB_<NAME> env vars.",
      );
    }

    for (const key of this.jobKeys) {
      if (!this.jobIds[key]) {
        logger.warn(`Job "${key}" has no valid job ID configured.`);
      }
    }

    logger.info(
      `Jobs plugin initialized with ${this.jobKeys.length} job(s): ${this.jobKeys.join(", ")}`,
    );
  }

  private get client() {
    return getWorkspaceClient();
  }

  private getJobId(jobKey: string): number {
    const id = this.jobIds[jobKey];
    if (!id) {
      throw new Error(
        `Job "${jobKey}" has no configured job ID. Set DATABRICKS_JOB_${jobKey.toUpperCase()} env var.`,
      );
    }
    return id;
  }

  /**
   * Creates a JobAPI for a specific configured job key.
   * Each method is scoped to the job's configured ID.
   */
  protected createJobAPI(jobKey: string): JobAPI {
    const jobId = this.getJobId(jobKey);
    const pollInterval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    const waitTimeout = this.config.timeout ?? DEFAULT_WAIT_TIMEOUT;

    return {
      runNow: async (params?: jobsTypes.RunNow) => {
        return this.connector.runNow(this.client, {
          ...params,
          job_id: jobId,
        });
      },

      runNowAndWait: async (
        params?: jobsTypes.RunNow,
        options?: { timeoutMs?: number; signal?: AbortSignal },
      ) => {
        const result = await this.connector.runNow(this.client, {
          ...params,
          job_id: jobId,
        });
        const runId = result.run_id;
        if (!runId) {
          throw new Error("runNow did not return a run_id");
        }
        return this.connector.waitForRun(
          this.client,
          runId,
          pollInterval,
          options?.timeoutMs ?? waitTimeout,
          options?.signal,
        );
      },

      lastRun: async () => {
        const runs = await this.connector.listRuns(this.client, {
          job_id: jobId,
          limit: 1,
        });
        return runs[0];
      },

      listRuns: async (options?: { limit?: number }) => {
        return this.connector.listRuns(this.client, {
          job_id: jobId,
          limit: options?.limit,
        });
      },

      getRun: async (runId: number) => {
        return this.connector.getRun(this.client, { run_id: runId });
      },

      getRunOutput: async (runId: number) => {
        return this.connector.getRunOutput(this.client, { run_id: runId });
      },

      cancelRun: async (runId: number) => {
        await this.connector.cancelRun(this.client, { run_id: runId });
      },

      getJob: async () => {
        return this.connector.getJob(this.client, { job_id: jobId });
      },
    };
  }

  exports(): JobsExport {
    const resolveJob = (jobKey: string): JobHandle => {
      if (!this.jobKeys.includes(jobKey)) {
        throw new Error(
          `Unknown job "${jobKey}". Available jobs: ${this.jobKeys.join(", ")}`,
        );
      }

      const spApi = this.createJobAPI(jobKey);

      return {
        ...spApi,
        asUser: (req: IAppRequest) => {
          const userPlugin = this.asUser(req) as JobsPlugin;
          return userPlugin.createJobAPI(jobKey);
        },
      };
    };

    const jobsExport = ((jobKey: string) => resolveJob(jobKey)) as JobsExport;
    jobsExport.job = resolveJob;

    return jobsExport;
  }

  clientConfig(): Record<string, unknown> {
    return { jobs: this.jobKeys };
  }
}

/**
 * @internal
 */
export const jobs = toPlugin(JobsPlugin);

export { JobsPlugin };

import type { jobs as jobsTypes } from "@databricks/sdk-experimental";
import type express from "express";
import type { IAppRequest, IAppRouter, PluginExecutionSettings } from "shared";
import { toJSONSchema } from "zod";
import { JobsConnector } from "../../connectors/jobs";
import { getWorkspaceClient } from "../../context";
import { InitializationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest, ResourceRequirement } from "../../registry";
import { ResourceType } from "../../registry";
import { JOBS_READ_DEFAULTS, JOBS_WRITE_DEFAULTS } from "./defaults";
import manifest from "./manifest.json";
import { mapParams } from "./params";
import type {
  IJobsConfig,
  JobAPI,
  JobConfig,
  JobHandle,
  JobRunStatus,
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
  private jobConfigs: Record<string, JobConfig> = {};
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
      discovered.default = {};
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
    this.jobConfigs = jobs;

    for (const key of this.jobKeys) {
      const envVar =
        key === "default"
          ? "DATABRICKS_JOB_ID"
          : `DATABRICKS_JOB_${key.toUpperCase()}`;
      const jobIdStr = process.env[envVar];
      if (jobIdStr) {
        const parsed = Number.parseInt(jobIdStr, 10);
        if (!Number.isNaN(parsed)) {
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

  private _readSettings(
    cacheKey: (string | number | object)[],
  ): PluginExecutionSettings {
    return {
      default: {
        ...JOBS_READ_DEFAULTS,
        cache: { ...JOBS_READ_DEFAULTS.cache, cacheKey },
      },
    };
  }

  /**
   * Creates a JobAPI for a specific configured job key.
   * Each method is scoped to the job's configured ID.
   */
  protected createJobAPI(jobKey: string): JobAPI {
    const jobId = this.getJobId(jobKey);
    const jobConfig = this.jobConfigs[jobKey];
    // Capture `this` for use in the async generator
    const self = this;

    return {
      runNow: async (
        params?: Record<string, unknown>,
      ): Promise<jobsTypes.RunNowResponse | undefined> => {
        // Validate if schema exists
        if (jobConfig?.params && params) {
          const result = jobConfig.params.safeParse(params);
          if (!result.success) {
            throw new Error(
              `Parameter validation failed for job "${jobKey}": ${result.error.message}`,
            );
          }
        }

        // Map params to SDK fields
        const sdkFields =
          jobConfig?.taskType && params
            ? mapParams(jobConfig.taskType, params)
            : (params ?? {});

        return this.execute(
          async () =>
            this.connector.runNow(this.client, {
              ...sdkFields,
              job_id: jobId,
            }),
          { default: JOBS_WRITE_DEFAULTS },
        );
      },

      async *runAndWait(
        params?: Record<string, unknown>,
      ): AsyncGenerator<JobRunStatus, void, unknown> {
        // Validate if schema exists
        if (jobConfig?.params && params) {
          const result = jobConfig.params.safeParse(params);
          if (!result.success) {
            throw new Error(
              `Parameter validation failed for job "${jobKey}": ${result.error.message}`,
            );
          }
        }

        // Map params to SDK fields
        const sdkFields =
          jobConfig?.taskType && params
            ? mapParams(jobConfig.taskType, params)
            : (params ?? {});

        const runResult = await self.execute(
          async () =>
            self.connector.runNow(self.client, {
              ...sdkFields,
              job_id: jobId,
            }),
          { default: JOBS_WRITE_DEFAULTS },
        );

        const runId = runResult?.run_id;
        if (!runId) {
          throw new Error("runNow did not return a run_id");
        }

        const pollInterval =
          self.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
        const timeout = jobConfig?.timeout ?? DEFAULT_WAIT_TIMEOUT;
        const startTime = Date.now();

        while (true) {
          if (Date.now() - startTime > timeout) {
            throw new Error(
              `Job run ${runId} polling timeout after ${timeout}ms`,
            );
          }

          const run = await self.connector.getRun(self.client, {
            run_id: runId,
          });
          const state = run.state?.life_cycle_state;

          yield { status: state, timestamp: Date.now(), run };

          if (
            state === "TERMINATED" ||
            state === "SKIPPED" ||
            state === "INTERNAL_ERROR"
          ) {
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
      },

      lastRun: async (): Promise<jobsTypes.Run | undefined> => {
        const runs = await this.execute(
          async () =>
            this.connector.listRuns(this.client, {
              job_id: jobId,
              limit: 1,
            }),
          this._readSettings(["jobs:lastRun", jobKey]),
        );
        return runs?.[0];
      },

      listRuns: async (options?: {
        limit?: number;
      }): Promise<jobsTypes.BaseRun[] | undefined> => {
        return this.execute(
          async () =>
            this.connector.listRuns(this.client, {
              job_id: jobId,
              limit: options?.limit,
            }),
          this._readSettings(["jobs:listRuns", jobKey, options ?? {}]),
        );
      },

      getRun: async (runId: number): Promise<jobsTypes.Run | undefined> => {
        return this.execute(
          async () => this.connector.getRun(this.client, { run_id: runId }),
          this._readSettings(["jobs:getRun", jobKey, runId]),
        );
      },

      getRunOutput: async (
        runId: number,
      ): Promise<jobsTypes.RunOutput | undefined> => {
        return this.execute(
          async () =>
            this.connector.getRunOutput(this.client, { run_id: runId }),
          this._readSettings(["jobs:getRunOutput", jobKey, runId]),
        );
      },

      cancelRun: async (runId: number): Promise<void> => {
        await this.execute(
          async () => this.connector.cancelRun(this.client, { run_id: runId }),
          { default: JOBS_WRITE_DEFAULTS },
        );
      },

      getJob: async (): Promise<jobsTypes.Job | undefined> => {
        return this.execute(
          async () => this.connector.getJob(this.client, { job_id: jobId }),
          this._readSettings(["jobs:getJob", jobKey]),
        );
      },
    };
  }

  /**
   * Resolve `:jobKey` from the request. Returns the key and ID,
   * or sends a 404 and returns `{ jobKey: undefined, jobId: undefined }`.
   */
  private _resolveJob(
    req: express.Request,
    res: express.Response,
  ):
    | { jobKey: string; jobId: number }
    | { jobKey: undefined; jobId: undefined } {
    const jobKey = req.params.jobKey;
    if (!this.jobKeys.includes(jobKey)) {
      const safeKey = jobKey.replace(/[^a-zA-Z0-9_-]/g, "");
      res.status(404).json({
        error: `Unknown job "${safeKey}"`,
        plugin: this.name,
      });
      return { jobKey: undefined, jobId: undefined };
    }
    const jobId = this.jobIds[jobKey];
    if (!jobId) {
      res.status(404).json({
        error: `Job "${jobKey}" has no configured job ID`,
        plugin: this.name,
      });
      return { jobKey: undefined, jobId: undefined };
    }
    return { jobKey, jobId };
  }

  injectRoutes(router: IAppRouter) {
    // POST /:jobKey/run
    this.route(router, {
      name: "run",
      method: "post",
      path: "/:jobKey/run",
      handler: async (req: express.Request, res: express.Response) => {
        const { jobKey } = this._resolveJob(req, res);
        if (!jobKey) return;

        const params = req.body?.params as Record<string, unknown> | undefined;
        const stream = req.query.stream === "true";

        try {
          const userPlugin = this.asUser(req) as JobsPlugin;
          const api = userPlugin.createJobAPI(jobKey);

          if (stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders();

            for await (const event of api.runAndWait(params)) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
          } else {
            const result = await api.runNow(params);
            res.json({ runId: result?.run_id });
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("validation failed")
          ) {
            res.status(400).json({ error: error.message, plugin: this.name });
            return;
          }
          logger.error("Run failed for job %s: %O", jobKey, error);
          res.status(500).json({ error: "Run failed", plugin: this.name });
        }
      },
    });

    // GET /:jobKey/runs
    this.route(router, {
      name: "runs",
      method: "get",
      path: "/:jobKey/runs",
      handler: async (req: express.Request, res: express.Response) => {
        const { jobKey } = this._resolveJob(req, res);
        if (!jobKey) return;

        const limit = Number.parseInt(req.query.limit as string, 10) || 20;

        try {
          const userPlugin = this.asUser(req) as JobsPlugin;
          const api = userPlugin.createJobAPI(jobKey);
          const runs = await api.listRuns({ limit });
          res.json({ runs: runs ?? [] });
        } catch (error) {
          logger.error("List runs failed for job %s: %O", jobKey, error);
          res
            .status(500)
            .json({ error: "List runs failed", plugin: this.name });
        }
      },
    });

    // GET /:jobKey/runs/:runId
    this.route(router, {
      name: "run-detail",
      method: "get",
      path: "/:jobKey/runs/:runId",
      handler: async (req: express.Request, res: express.Response) => {
        const { jobKey } = this._resolveJob(req, res);
        if (!jobKey) return;

        const runId = Number.parseInt(req.params.runId, 10);
        if (Number.isNaN(runId)) {
          res.status(400).json({ error: "Invalid runId", plugin: this.name });
          return;
        }

        try {
          const userPlugin = this.asUser(req) as JobsPlugin;
          const api = userPlugin.createJobAPI(jobKey);
          const run = await api.getRun(runId);
          if (!run) {
            res.status(404).json({ error: "Run not found", plugin: this.name });
            return;
          }
          res.json(run);
        } catch (error) {
          logger.error(
            "Get run failed for job %s run %d: %O",
            jobKey,
            runId,
            error,
          );
          res.status(500).json({ error: "Get run failed", plugin: this.name });
        }
      },
    });

    // GET /:jobKey/status
    this.route(router, {
      name: "status",
      method: "get",
      path: "/:jobKey/status",
      handler: async (req: express.Request, res: express.Response) => {
        const { jobKey } = this._resolveJob(req, res);
        if (!jobKey) return;

        try {
          const userPlugin = this.asUser(req) as JobsPlugin;
          const api = userPlugin.createJobAPI(jobKey);
          const lastRun = await api.lastRun();
          res.json({
            status: lastRun?.state?.life_cycle_state ?? null,
            run: lastRun ?? null,
          });
        } catch (error) {
          logger.error("Status check failed for job %s: %O", jobKey, error);
          res
            .status(500)
            .json({ error: "Status check failed", plugin: this.name });
        }
      },
    });
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
    const jobs: Record<string, { params: unknown }> = {};
    for (const key of this.jobKeys) {
      const config = this.jobConfigs[key];
      jobs[key] = {
        params: config?.params ? toJSONSchema(config.params) : null,
      };
    }
    return { jobs };
  }
}

/**
 * @internal
 */
export const jobs = toPlugin(JobsPlugin);

export { JobsPlugin };

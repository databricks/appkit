import { STATUS_CODES } from "node:http";
import type { jobs as jobsTypes } from "@databricks/sdk-experimental";
import type express from "express";
import type {
  IAppRequest,
  IAppRouter,
  PluginExecutionSettings,
  StreamExecutionSettings,
} from "shared";
import { toJSONSchema } from "zod";
import { JobsConnector } from "../../connectors/jobs";
import { getCurrentUserId, getWorkspaceClient } from "../../context";
import { ExecutionError, ValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { ExecutionResult } from "../../plugin";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest, ResourceRequirement } from "../../registry";
import { ResourceType } from "../../registry";
import {
  JOBS_READ_DEFAULTS,
  JOBS_STREAM_DEFAULTS,
  JOBS_WRITE_DEFAULTS,
} from "./defaults";
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

const DEFAULT_WAIT_TIMEOUT = 600_000;
const DEFAULT_POLL_INTERVAL = 5_000;
/** Cap on param-key count when a job has no Zod schema. Jobs that need more keys must define a schema. */
const MAX_UNVALIDATED_PARAM_KEYS = 50;

/** Replace upstream error messages with generic descriptions keyed by HTTP status. */
function errorResult(status: number): ExecutionResult<never> {
  return {
    ok: false,
    status,
    message: STATUS_CODES[status] ?? "Request failed",
  };
}

function isTerminalRunState(state: string | undefined): boolean {
  return (
    state === "TERMINATED" || state === "SKIPPED" || state === "INTERNAL_ERROR"
  );
}

/** Exponential backoff (1.5x) with +/- 20% jitter, capped at `max`. */
function nextPollDelay(
  current: number,
  max: number,
): { delay: number; next: number } {
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return {
    delay: Math.min(current * jitter, max),
    next: Math.min(current * 1.5, max),
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

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
      const envVar =
        jobKey === "default"
          ? "DATABRICKS_JOB_ID"
          : `DATABRICKS_JOB_${jobKey.toUpperCase()}`;
      throw new Error(
        `Job "${jobKey}" has no configured job ID. Set ${envVar} env var.`,
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
        ...(this.config.timeout != null && { timeout: this.config.timeout }),
        cache: { ...JOBS_READ_DEFAULTS.cache, cacheKey },
      },
    };
  }

  private _writeSettings(): PluginExecutionSettings {
    return {
      default: {
        ...JOBS_WRITE_DEFAULTS,
        ...(this.config.timeout != null && { timeout: this.config.timeout }),
      },
    };
  }

  /**
   * Validates params against the job's Zod schema (if any) and maps them
   * to SDK request fields based on the task type. Shared by runNow and runAndWait.
   */
  private _validateAndMap(
    jobKey: string,
    params?: Record<string, unknown>,
  ): Record<string, unknown> {
    const jobConfig = this.jobConfigs[jobKey];
    let validated = params;

    if (jobConfig?.params) {
      const result = jobConfig.params.safeParse(params ?? {});
      if (!result.success) {
        throw new ValidationError(
          `Parameter validation failed for job "${jobKey}": ${result.error.message}`,
        );
      }
      validated = result.data as Record<string, unknown>;
    }

    return jobConfig?.taskType && validated
      ? mapParams(jobConfig.taskType, validated)
      : (validated ?? {});
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
    // Eagerly capture the client and userId so that when createJobAPI is
    // called inside an asUser() proxy (which runs in user context), the
    // closures below use the user-scoped client instead of falling back
    // to the service principal when the ALS context has already exited.
    const client = this.client;
    const userKey = getCurrentUserId();

    /**
     * Verify that `runId` belongs to this job's configured `jobId`. Returns
     * null if the run is in scope; otherwise returns a 404 `ExecutionResult`.
     * Prevents cross-job access via the `/:jobKey/runs/:runId` HTTP surface.
     */
    const verifyRunScope = async (
      runId: number,
    ): Promise<ExecutionResult<never> | null> => {
      const result = await self.execute(
        async (signal) =>
          self.connector.getRun(client, { run_id: runId }, signal),
        self._readSettings(["jobs:getRun", jobKey, runId]),
        userKey,
      );
      if (!result.ok) return errorResult(result.status);
      if (result.data.job_id !== jobId) return errorResult(404);
      return null;
    };

    return {
      runNow: async (
        params?: Record<string, unknown>,
      ): Promise<ExecutionResult<jobsTypes.RunNowResponse>> => {
        const sdkFields = self._validateAndMap(jobKey, params);

        const result = await self.execute(
          async (signal) =>
            self.connector.runNow(
              client,
              { ...sdkFields, job_id: jobId },
              signal,
            ),
          self._writeSettings(),
          userKey,
        );
        return result.ok ? result : errorResult(result.status);
      },

      async *runAndWait(
        params?: Record<string, unknown>,
        signal?: AbortSignal,
      ): AsyncGenerator<JobRunStatus, void, unknown> {
        const sdkFields = self._validateAndMap(jobKey, params);

        const runResult = await self.execute(
          async (signal) =>
            self.connector.runNow(
              client,
              { ...sdkFields, job_id: jobId },
              signal,
            ),
          self._writeSettings(),
          userKey,
        );

        if (!runResult.ok) {
          throw new ExecutionError("Failed to trigger job run");
        }
        const runId = runResult.data.run_id;
        if (!runId) {
          throw new Error("runNow did not return a run_id");
        }

        const basePollInterval =
          self.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
        const maxPollInterval = basePollInterval * 6;
        const timeout = jobConfig?.waitTimeout ?? DEFAULT_WAIT_TIMEOUT;
        const startTime = Date.now();
        let currentInterval = basePollInterval;

        while (!signal?.aborted) {
          if (Date.now() - startTime > timeout) {
            throw new Error(
              `Job run ${runId} polling timeout after ${timeout}ms`,
            );
          }

          const runStatusResult = await self.execute(
            async (signal) =>
              self.connector.getRun(client, { run_id: runId }, signal),
            {
              default: {
                ...JOBS_READ_DEFAULTS,
                cache: { enabled: false },
              },
            },
            userKey,
          );
          if (!runStatusResult.ok) {
            throw new ExecutionError(
              `Failed to poll run status for run ${runId}`,
            );
          }
          const run = runStatusResult.data;
          const state = run.state?.life_cycle_state;

          yield { status: state, timestamp: Date.now(), run };

          if (isTerminalRunState(state)) return;

          const { delay, next } = nextPollDelay(
            currentInterval,
            maxPollInterval,
          );
          currentInterval = next;
          await abortableSleep(delay, signal);
        }
      },

      lastRun: async (): Promise<
        ExecutionResult<jobsTypes.BaseRun | undefined>
      > => {
        const result = await self.execute(
          async (signal) =>
            self.connector.listRuns(
              client,
              { job_id: jobId, limit: 1 },
              signal,
            ),
          self._readSettings(["jobs:lastRun", jobKey]),
          userKey,
        );
        if (!result.ok) return errorResult(result.status);
        return { ok: true, data: result.data[0] };
      },

      listRuns: async (options?: {
        limit?: number;
      }): Promise<ExecutionResult<jobsTypes.BaseRun[]>> => {
        const result = await self.execute(
          async (signal) =>
            self.connector.listRuns(
              client,
              { job_id: jobId, limit: options?.limit },
              signal,
            ),
          self._readSettings([
            "jobs:listRuns",
            jobKey,
            options?.limit ?? "default",
          ]),
          userKey,
        );
        return result.ok ? result : errorResult(result.status);
      },

      getRun: async (
        runId: number,
      ): Promise<ExecutionResult<jobsTypes.Run>> => {
        const result = await self.execute(
          async (signal) =>
            self.connector.getRun(client, { run_id: runId }, signal),
          self._readSettings(["jobs:getRun", jobKey, runId]),
          userKey,
        );
        if (!result.ok) return errorResult(result.status);
        if (result.data.job_id !== jobId) return errorResult(404);
        return result;
      },

      getRunOutput: async (
        runId: number,
      ): Promise<ExecutionResult<jobsTypes.RunOutput>> => {
        const scopeError = await verifyRunScope(runId);
        if (scopeError) return scopeError;
        const result = await self.execute(
          async (signal) =>
            self.connector.getRunOutput(client, { run_id: runId }, signal),
          self._readSettings(["jobs:getRunOutput", jobKey, runId]),
          userKey,
        );
        return result.ok ? result : errorResult(result.status);
      },

      cancelRun: async (runId: number): Promise<ExecutionResult<void>> => {
        const scopeError = await verifyRunScope(runId);
        if (scopeError) return scopeError;
        const result = await self.execute(
          async (signal) =>
            self.connector.cancelRun(client, { run_id: runId }, signal),
          self._writeSettings(),
          userKey,
        );
        return result.ok ? result : errorResult(result.status);
      },

      getJob: async (): Promise<ExecutionResult<jobsTypes.Job>> => {
        const result = await self.execute(
          async (signal) =>
            self.connector.getJob(client, { job_id: jobId }, signal),
          self._readSettings(["jobs:getJob", jobKey]),
          userKey,
        );
        return result.ok ? result : errorResult(result.status);
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

  private _sendStatusError(res: express.Response, status: number): void {
    res.status(status).json({
      error: STATUS_CODES[status] ?? "Unknown Error",
      plugin: this.name,
    });
  }

  /**
   * Validate params from an HTTP request body. Eager validation lets streaming
   * requests get a clean 400 instead of a generic SSE error event. Throws
   * ValidationError so handlers can map to a 400 response via their catch block.
   */
  private _parseRunParams(
    jobKey: string,
    rawParams: unknown,
  ): Record<string, unknown> | undefined {
    if (
      rawParams !== undefined &&
      (typeof rawParams !== "object" ||
        rawParams === null ||
        Array.isArray(rawParams))
    ) {
      throw new ValidationError("params must be a plain object");
    }

    const jobConfig = this.jobConfigs[jobKey];
    if (jobConfig?.params) {
      const result = jobConfig.params.safeParse(rawParams ?? {});
      if (!result.success) {
        throw new ValidationError("Invalid job parameters");
      }
      // Pass rawParams — not result.data — to avoid double-transforming
      // when _validateAndMap calls safeParse again downstream.
      return rawParams as Record<string, unknown>;
    }
    // No schema. Either reject (no taskType) or enforce a key cap so that
    // untrusted clients can't spread arbitrarily many fields into the SDK.
    if (rawParams !== undefined) {
      if (!jobConfig?.taskType) {
        throw new ValidationError("This job does not accept parameters");
      }
      const keyCount = Object.keys(rawParams as Record<string, unknown>).length;
      if (keyCount > MAX_UNVALIDATED_PARAM_KEYS) {
        throw new ValidationError(
          `Too many parameters (${keyCount}). Define a Zod schema to accept more than ${MAX_UNVALIDATED_PARAM_KEYS}.`,
        );
      }
    }
    return rawParams as Record<string, unknown> | undefined;
  }

  private async _handleRun(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { jobKey } = this._resolveJob(req, res);
    if (!jobKey) return;

    const stream = req.query.stream === "true";

    try {
      const params = this._parseRunParams(jobKey, req.body?.params);
      const api = this.createJobAPI(jobKey);

      if (stream) {
        const streamSettings: StreamExecutionSettings = {
          default: JOBS_STREAM_DEFAULTS,
        };
        await this.executeStream<JobRunStatus>(
          res,
          (signal) => api.runAndWait(params, signal),
          streamSettings,
        );
      } else {
        const result = await api.runNow(params);
        if (!result.ok) {
          this._sendStatusError(res, result.status);
          return;
        }
        res.json({ runId: result.data.run_id });
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        if (!res.headersSent) {
          res.status(400).json({ error: error.message, plugin: this.name });
        }
        return;
      }
      logger.error("Run failed for job %s: %O", jobKey, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Run failed", plugin: this.name });
      }
    }
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "run",
      method: "post",
      path: "/:jobKey/run",
      handler: (req, res) => this._handleRun(req, res),
    });

    // GET /:jobKey/runs
    this.route(router, {
      name: "runs",
      method: "get",
      path: "/:jobKey/runs",
      handler: async (req: express.Request, res: express.Response) => {
        const { jobKey } = this._resolveJob(req, res);
        if (!jobKey) return;

        const limit = Math.max(
          1,
          Math.min(Number.parseInt(req.query.limit as string, 10) || 20, 100),
        );

        try {
          const api = this.createJobAPI(jobKey);
          const result = await api.listRuns({ limit });
          if (!result.ok) {
            this._sendStatusError(res, result.status);
            return;
          }
          res.json({ runs: result.data });
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
        if (Number.isNaN(runId) || runId <= 0) {
          res.status(400).json({ error: "Invalid runId", plugin: this.name });
          return;
        }

        try {
          const api = this.createJobAPI(jobKey);
          const result = await api.getRun(runId);
          if (!result.ok) {
            this._sendStatusError(res, result.status);
            return;
          }
          res.json(result.data);
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
          const api = this.createJobAPI(jobKey);
          const result = await api.lastRun();
          if (!result.ok) {
            this._sendStatusError(res, result.status);
            return;
          }
          res.json({
            status: result.data?.state?.life_cycle_state ?? null,
            run: result.data ?? null,
          });
        } catch (error) {
          logger.error("Status check failed for job %s: %O", jobKey, error);
          res
            .status(500)
            .json({ error: "Status check failed", plugin: this.name });
        }
      },
    });

    // DELETE /:jobKey/runs/:runId
    this.route(router, {
      name: "cancel-run",
      method: "delete",
      path: "/:jobKey/runs/:runId",
      handler: async (req: express.Request, res: express.Response) => {
        const { jobKey } = this._resolveJob(req, res);
        if (!jobKey) return;

        const runId = Number.parseInt(req.params.runId, 10);
        if (Number.isNaN(runId) || runId <= 0) {
          res.status(400).json({ error: "Invalid runId", plugin: this.name });
          return;
        }

        try {
          const api = this.createJobAPI(jobKey);
          const result = await api.cancelRun(runId);
          if (!result.ok) {
            this._sendStatusError(res, result.status);
            return;
          }
          res.status(204).end();
        } catch (error) {
          logger.error(
            "Cancel run failed for job %s run %d: %O",
            jobKey,
            runId,
            error,
          );
          res
            .status(500)
            .json({ error: "Cancel run failed", plugin: this.name });
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

    return resolveJob as JobsExport;
  }

  clientConfig(): Record<string, unknown> {
    const jobs: Record<string, { params: unknown; taskType: string | null }> =
      {};
    for (const key of this.jobKeys) {
      const config = this.jobConfigs[key];
      jobs[key] = {
        params: config?.params ? toJSONSchema(config.params) : null,
        taskType: config?.taskType ?? null,
      };
    }
    return { jobs };
  }
}

/**
 * @internal
 */
export const jobs = toPlugin(JobsPlugin);

/**
 * @internal
 */
export { JobsPlugin };

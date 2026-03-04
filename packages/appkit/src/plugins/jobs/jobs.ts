import { randomUUID } from "node:crypto";
import type express from "express";
import type { IAppRouter, StreamExecutionSettings } from "shared";
import { type JobRunStreamEvent, JobsConnector } from "../../connectors/jobs";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { jobsStreamDefaults } from "./defaults";
import manifest from "./manifest.json";
import type { IJobsConfig, TriggerJobRequest } from "./types";

const logger = createLogger("jobs");

export class JobsPlugin extends Plugin {
  name = "jobs";

  static manifest = manifest as PluginManifest;

  protected declare config: IJobsConfig;

  private readonly jobsConnector: JobsConnector;

  constructor(config: IJobsConfig) {
    super(config);
    this.config = {
      ...config,
      jobs: config.jobs ?? this.defaultJobs(),
    };
    this.jobsConnector = new JobsConnector({
      timeout: this.config.timeout,
    });
  }

  private defaultJobs(): Record<string, number> {
    const jobId = process.env.DATABRICKS_JOB_ID;
    return jobId ? { default: Number(jobId) } : {};
  }

  private resolveJobId(alias: string): number | null {
    return this.config.jobs?.[alias] ?? null;
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "trigger",
      method: "post",
      path: "/:alias/trigger",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleTrigger(req, res);
      },
    });

    this.route(router, {
      name: "getRun",
      method: "get",
      path: "/runs/:runId",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleGetRun(req, res);
      },
    });

    this.route(router, {
      name: "cancelRun",
      method: "post",
      path: "/runs/:runId/cancel",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleCancelRun(req, res);
      },
    });
  }

  async _handleTrigger(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias } = req.params;
    const jobId = this.resolveJobId(alias);

    if (!jobId) {
      res.status(404).json({ error: `Unknown job alias: ${alias}` });
      return;
    }

    const body = req.body as TriggerJobRequest;

    logger.debug("Triggering job %d (alias=%s)", jobId, alias);

    const timeout = this.config.timeout ?? 600_000;
    const requestId = (req.query.requestId as string) || randomUUID();

    const streamSettings: StreamExecutionSettings = {
      ...jobsStreamDefaults,
      default: {
        ...jobsStreamDefaults.default,
        timeout,
      },
      stream: {
        ...jobsStreamDefaults.stream,
        streamId: requestId,
      },
    };

    const workspaceClient = getWorkspaceClient();

    await this.executeStream<JobRunStreamEvent>(
      res,
      () =>
        this.jobsConnector.streamRunJob(workspaceClient, jobId, body, {
          timeout,
        }),
      streamSettings,
    );
  }

  async _handleGetRun(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const runId = Number(req.params.runId);

    if (!runId || Number.isNaN(runId)) {
      res.status(400).json({ error: "Valid runId is required" });
      return;
    }

    logger.debug("Fetching run %d", runId);

    const workspaceClient = getWorkspaceClient();
    const run = await this.jobsConnector.getRun(workspaceClient, runId);
    res.json(run);
  }

  async _handleCancelRun(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const runId = Number(req.params.runId);

    if (!runId || Number.isNaN(runId)) {
      res.status(400).json({ error: "Valid runId is required" });
      return;
    }

    logger.debug("Cancelling run %d", runId);

    const workspaceClient = getWorkspaceClient();

    try {
      await this.jobsConnector.cancelRun(workspaceClient, runId);
      res.json({ runId, status: "cancelled" });
    } catch (error) {
      logger.error("Failed to cancel run %d: %O", runId, error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to cancel run",
      });
    }
  }

  /**
   * Trigger a job run and stream status events.
   * When called via asUser(req), uses the user's Databricks credentials.
   */
  async *triggerJob(
    alias: string,
    params?: TriggerJobRequest,
    options?: { timeout?: number },
  ): AsyncGenerator<JobRunStreamEvent> {
    const jobId = this.resolveJobId(alias);
    if (!jobId) {
      throw new Error(`Unknown job alias: ${alias}`);
    }
    const workspaceClient = getWorkspaceClient();
    const timeout = options?.timeout ?? this.config.timeout ?? 600_000;
    yield* this.jobsConnector.streamRunJob(workspaceClient, jobId, params, {
      timeout,
    });
  }

  /**
   * Get the current status of a run.
   */
  async getRun(runId: number) {
    const workspaceClient = getWorkspaceClient();
    return this.jobsConnector.getRun(workspaceClient, runId);
  }

  /**
   * Cancel a running job run.
   */
  async cancelRun(runId: number) {
    const workspaceClient = getWorkspaceClient();
    return this.jobsConnector.cancelRun(workspaceClient, runId);
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  /**
   * Public API accessible via `AppKit.jobs`.
   * `asUser()` is automatically added by AppKit.
   */
  exports() {
    return {
      triggerJob: this.triggerJob,
      getRun: this.getRun,
      cancelRun: this.cancelRun,
    };
  }
}

/**
 * @internal
 */
export const jobs = toPlugin<typeof JobsPlugin, IJobsConfig, "jobs">(
  JobsPlugin,
  "jobs",
);

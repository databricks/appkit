import { AppKitError, ExecutionError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { TelemetryProvider } from "../../telemetry";
import {
  type Counter,
  type Histogram,
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
} from "../../telemetry";
import { isPlainObject } from "../../utils/is-plain-object";
import type {
  CancelRunRequest,
  GetJobRequest,
  GetRunOutputRequest,
  GetRunRequest,
  ListRunsRequest,
  RunNowRequest,
  SubmitRunRequest,
  WorkspaceClient,
} from "../../workspace-client";
import type {
  JobBaseRun,
  JobDetails,
  JobRun,
  JobRunNowResponse,
  JobRunOutput,
  JobsConnectorConfig,
  JobSubmitRunResponse,
  Numeric,
} from "./types";

const logger = createLogger("connectors:jobs");

/**
 * The modular SDK types int64s as `bigint`, which `JSON.stringify` rejects, and
 * every jobs response ends up in HTTP JSON, SSE or the cache. `Number()` loses
 * precision past 2^53, as the legacy SDK's plain `JSON.parse` did.
 */
function toNumbers<T>(value: T): Numeric<T> {
  if (typeof value === "bigint") return Number(value) as Numeric<T>;
  if (Array.isArray(value)) return value.map(toNumbers) as Numeric<T>;
  if (!isPlainObject(value)) return value as Numeric<T>;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, toNumbers(v)]),
  ) as Numeric<T>;
}

export class JobsConnector {
  private readonly name = "jobs";
  private readonly config: JobsConnectorConfig;
  private readonly telemetry: TelemetryProvider;
  private readonly telemetryMetrics: {
    apiCallCount: Counter;
    apiCallDuration: Histogram;
  };

  constructor(config: JobsConnectorConfig) {
    this.config = config;
    this.telemetry = TelemetryManager.getProvider(
      this.name,
      this.config.telemetry,
    );
    this.telemetryMetrics = {
      apiCallCount: this.telemetry
        .getMeter()
        .createCounter("jobs.api_call.count", {
          description: "Total number of Jobs API calls",
          unit: "1",
        }),
      apiCallDuration: this.telemetry
        .getMeter()
        .createHistogram("jobs.api_call.duration", {
          description: "Duration of Jobs API calls",
          unit: "ms",
        }),
    };
  }

  async submitRun(
    workspaceClient: WorkspaceClient,
    request: SubmitRunRequest,
    signal?: AbortSignal,
  ): Promise<JobSubmitRunResponse> {
    return this._callApi("submit", async () => {
      const waiter = await workspaceClient.jobs.submitRun(request, { signal });
      return { runId: Number(waiter.runId) };
    });
  }

  async runNow(
    workspaceClient: WorkspaceClient,
    request: RunNowRequest,
    signal?: AbortSignal,
  ): Promise<JobRunNowResponse> {
    return this._callApi("runNow", async () => {
      const waiter = await workspaceClient.jobs.runNow(request, { signal });
      return { runId: Number(waiter.runId) };
    });
  }

  async getRun(
    workspaceClient: WorkspaceClient,
    request: GetRunRequest,
    signal?: AbortSignal,
  ): Promise<JobRun> {
    return this._callApi("getRun", async () =>
      toNumbers(await workspaceClient.jobs.getRun(request, { signal })),
    );
  }

  async getRunOutput(
    workspaceClient: WorkspaceClient,
    request: GetRunOutputRequest,
    signal?: AbortSignal,
  ): Promise<JobRunOutput> {
    return this._callApi("getRunOutput", async () =>
      toNumbers(await workspaceClient.jobs.getRunOutput(request, { signal })),
    );
  }

  async cancelRun(
    workspaceClient: WorkspaceClient,
    request: CancelRunRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    await this._callApi("cancelRun", async () => {
      await workspaceClient.jobs.cancelRun(request, { signal });
    });
  }

  async listRuns(
    workspaceClient: WorkspaceClient,
    request: ListRunsRequest,
    signal?: AbortSignal,
  ): Promise<JobBaseRun[]> {
    return this._callApi("listRuns", async () => {
      const runs: JobBaseRun[] = [];
      const limit = Math.max(1, Math.min(request.limit ?? 100, 100));
      for await (const run of workspaceClient.jobs.listRunsIter(
        { ...request, limit },
        { signal },
      )) {
        runs.push(toNumbers(run));
        if (runs.length >= limit) break;
      }
      return runs;
    });
  }

  async getJob(
    workspaceClient: WorkspaceClient,
    request: GetJobRequest,
    signal?: AbortSignal,
  ): Promise<JobDetails> {
    return this._callApi("getJob", async () =>
      toNumbers(await workspaceClient.jobs.getJob(request, { signal })),
    );
  }

  private async _callApi<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    let success = false;

    return this.telemetry.startActiveSpan(
      `jobs.${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "jobs.operation": operation,
        },
      },
      async (span: Span) => {
        try {
          const result = await fn();
          success = true;
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof AppKitError) {
            throw error;
          }
          // The modular SDK's ApiError exposes the HTTP status as
          // `httpStatusCode` (-1 when not an HTTP error); Plugin.execute()
          // maps on `statusCode`.
          if (
            error instanceof Error &&
            "httpStatusCode" in error &&
            typeof error.httpStatusCode === "number" &&
            error.httpStatusCode > 0
          ) {
            throw Object.assign(error, { statusCode: error.httpStatusCode });
          }
          // Preserve SDK ApiError (and any error with a numeric statusCode)
          // so Plugin.execute() can map it to the correct HTTP status.
          if (
            error instanceof Error &&
            "statusCode" in error &&
            typeof (error as Record<string, unknown>).statusCode === "number"
          ) {
            throw error;
          }
          throw new ExecutionError(
            `Jobs API call failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          const duration = Date.now() - startTime;
          span.end();
          this.telemetryMetrics.apiCallCount.add(1, {
            operation,
            success: success.toString(),
          });
          this.telemetryMetrics.apiCallDuration.record(duration, {
            operation,
            success: success.toString(),
          });

          logger.event()?.setContext("jobs", {
            operation,
            duration_ms: duration,
            success,
          });
        }
      },
      { name: this.name, includePrefix: true },
    );
  }
}

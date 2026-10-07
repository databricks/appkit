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
import type {
  GetJobRequest,
  GetRunRequest,
  jobs,
  ListRunsRequest,
  RunNowRequest,
  SubmitRunRequest,
  WorkspaceClient,
} from "../../workspace-client";
import type { JobsConnectorConfig } from "./types";

const logger = createLogger("connectors:jobs");

/**
 * `Record<string, string>` fields of the Jobs model. Their keys are user data
 * (notebook params, tags, Spark conf), so they are copied verbatim instead of
 * re-cased.
 */
const MAP_FIELDS = new Set([
  "artifactsHeaders",
  "baseParameters",
  "customTags",
  "filters",
  "jobParameters",
  "namedParameters",
  "notebookBaseParameters",
  "notebookParams",
  "parameters",
  "pipelineTaskParameters",
  "pythonNamedParams",
  "sparkConf",
  "sparkEnvVars",
  "sqlParams",
  "tags",
  "variables",
  "violations",
]);

/** The one model field whose camelCase name doesn't round-trip to its wire key. */
const WIRE_KEY_OVERRIDES: Record<string, string> = {
  pipelineTaskParameters: "parameters",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Modular model → the legacy wire shape the plugin's public API (HTTP JSON, SSE,
 * cache) has always exposed: snake_case keys and `number` int64s. `bigint` would
 * make `JSON.stringify` throw. `Number()` loses precision past 2^53, exactly as
 * the legacy SDK's plain `JSON.parse` did.
 */
function toWire(value: unknown, verbatimKeys = false): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map((v) => toWire(v));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) =>
      verbatimKeys
        ? [key, v]
        : [
            WIRE_KEY_OVERRIDES[key] ??
              key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
            toWire(v, MAP_FIELDS.has(key)),
          ],
    ),
  );
}

/**
 * Legacy snake_case request → modular camelCase request. int64 fields (`job_id`,
 * `run_id`) still need an explicit `BigInt()` at the call site: the SDK's
 * marshal schemas reject a `number` there.
 */
function fromWire(value: unknown, verbatimKeys = false): unknown {
  if (Array.isArray(value)) return value.map((v) => fromWire(v));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => {
      if (verbatimKeys) return [key, v];
      const camel = key.replace(/_([a-z0-9])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      return [camel, fromWire(v, MAP_FIELDS.has(camel))];
    }),
  );
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
    request: jobs.SubmitRun,
    signal?: AbortSignal,
  ): Promise<jobs.SubmitRunResponse> {
    return this._callApi("submit", async () => {
      const waiter = await workspaceClient.jobs.submitRun(
        fromWire(request) as SubmitRunRequest,
        { signal },
      );
      return { run_id: Number(waiter.runId) };
    });
  }

  async runNow(
    workspaceClient: WorkspaceClient,
    request: jobs.RunNow,
    signal?: AbortSignal,
  ): Promise<jobs.RunNowResponse> {
    return this._callApi("runNow", async () => {
      const waiter = await workspaceClient.jobs.runNow(
        {
          ...(fromWire(request) as RunNowRequest),
          jobId: BigInt(request.job_id),
        },
        { signal },
      );
      // The waiter only exposes runId; the API documents number_in_job as
      // "set to the same value as run_id".
      const runId = Number(waiter.runId);
      return { run_id: runId, number_in_job: runId };
    });
  }

  async getRun(
    workspaceClient: WorkspaceClient,
    request: jobs.GetRunRequest,
    signal?: AbortSignal,
  ): Promise<jobs.Run> {
    return this._callApi("getRun", async () => {
      const run = await workspaceClient.jobs.getRun(
        {
          ...(fromWire(request) as GetRunRequest),
          runId: BigInt(request.run_id),
        },
        { signal },
      );
      return toWire(run) as jobs.Run;
    });
  }

  async getRunOutput(
    workspaceClient: WorkspaceClient,
    request: jobs.GetRunOutputRequest,
    signal?: AbortSignal,
  ): Promise<jobs.RunOutput> {
    return this._callApi("getRunOutput", async () => {
      const output = await workspaceClient.jobs.getRunOutput(
        { runId: BigInt(request.run_id) },
        { signal },
      );
      return toWire(output) as jobs.RunOutput;
    });
  }

  async cancelRun(
    workspaceClient: WorkspaceClient,
    request: jobs.CancelRun,
    signal?: AbortSignal,
  ): Promise<void> {
    await this._callApi("cancelRun", async () => {
      await workspaceClient.jobs.cancelRun(
        { runId: BigInt(request.run_id) },
        { signal },
      );
    });
  }

  async listRuns(
    workspaceClient: WorkspaceClient,
    request: jobs.ListRunsRequest,
    signal?: AbortSignal,
  ): Promise<jobs.BaseRun[]> {
    return this._callApi("listRuns", async () => {
      const runs: jobs.BaseRun[] = [];
      const limit = Math.max(1, Math.min(request.limit ?? 100, 100));
      for await (const run of workspaceClient.jobs.listRunsIter(
        {
          ...(fromWire(request) as ListRunsRequest),
          jobId:
            request.job_id === undefined ? undefined : BigInt(request.job_id),
          limit,
        },
        { signal },
      )) {
        runs.push(toWire(run) as jobs.BaseRun);
        if (runs.length >= limit) break;
      }
      return runs;
    });
  }

  async getJob(
    workspaceClient: WorkspaceClient,
    request: jobs.GetJobRequest,
    signal?: AbortSignal,
  ): Promise<jobs.Job> {
    return this._callApi("getJob", async () => {
      const job = await workspaceClient.jobs.getJob(
        {
          ...(fromWire(request) as GetJobRequest),
          jobId: BigInt(request.job_id),
        },
        { signal },
      );
      return toWire(job) as jobs.Job;
    });
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

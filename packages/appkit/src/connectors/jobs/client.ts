import {
  Context,
  type jobs,
  type WorkspaceClient,
} from "@databricks/sdk-experimental";
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
import type { JobsConnectorConfig } from "./types";

const logger = createLogger("connectors:jobs");

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
      return workspaceClient.jobs.submit(request, this._createContext(signal));
    });
  }

  async runNow(
    workspaceClient: WorkspaceClient,
    request: jobs.RunNow,
    signal?: AbortSignal,
  ): Promise<jobs.RunNowResponse> {
    return this._callApi("runNow", async () => {
      return workspaceClient.jobs.runNow(request, this._createContext(signal));
    });
  }

  async getRun(
    workspaceClient: WorkspaceClient,
    request: jobs.GetRunRequest,
    signal?: AbortSignal,
  ): Promise<jobs.Run> {
    return this._callApi("getRun", async () => {
      return workspaceClient.jobs.getRun(request, this._createContext(signal));
    });
  }

  async getRunOutput(
    workspaceClient: WorkspaceClient,
    request: jobs.GetRunOutputRequest,
    signal?: AbortSignal,
  ): Promise<jobs.RunOutput> {
    return this._callApi("getRunOutput", async () => {
      return workspaceClient.jobs.getRunOutput(
        request,
        this._createContext(signal),
      );
    });
  }

  async cancelRun(
    workspaceClient: WorkspaceClient,
    request: jobs.CancelRun,
    signal?: AbortSignal,
  ): Promise<void> {
    await this._callApi("cancelRun", async () => {
      return workspaceClient.jobs.cancelRun(
        request,
        this._createContext(signal),
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
      for await (const run of workspaceClient.jobs.listRuns(
        { ...request, limit },
        this._createContext(signal),
      )) {
        runs.push(run);
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
      return workspaceClient.jobs.get(request, this._createContext(signal));
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

  private _createContext(signal?: AbortSignal) {
    return new Context({
      cancellationToken: {
        // Getter — evaluated on every read so SDK code paths that poll
        // (rather than subscribe) observe cancellation live.
        get isCancellationRequested() {
          return signal?.aborted ?? false;
        },
        onCancellationRequested: (cb: () => void) => {
          signal?.addEventListener("abort", cb, { once: true });
        },
      },
    });
  }
}

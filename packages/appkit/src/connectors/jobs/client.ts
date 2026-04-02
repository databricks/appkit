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
      const waiter = await workspaceClient.jobs.submit(
        request,
        this._createContext(signal),
      );
      return waiter.response;
    });
  }

  async runNow(
    workspaceClient: WorkspaceClient,
    request: jobs.RunNow,
    signal?: AbortSignal,
  ): Promise<jobs.RunNowResponse> {
    return this._callApi("runNow", async () => {
      const waiter = await workspaceClient.jobs.runNow(
        request,
        this._createContext(signal),
      );
      return waiter.response;
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
      const waiter = await workspaceClient.jobs.cancelRun(
        request,
        this._createContext(signal),
      );
      return waiter.response;
    });
  }

  async listRuns(
    workspaceClient: WorkspaceClient,
    request: jobs.ListRunsRequest,
    signal?: AbortSignal,
  ): Promise<jobs.BaseRun[]> {
    return this._callApi("listRuns", async () => {
      const runs: jobs.BaseRun[] = [];
      const limit = request.limit;
      for await (const run of workspaceClient.jobs.listRuns(
        request,
        this._createContext(signal),
      )) {
        runs.push(run);
        if (limit && runs.length >= limit) break;
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

  async createJob(
    workspaceClient: WorkspaceClient,
    request: jobs.CreateJob,
    signal?: AbortSignal,
  ): Promise<jobs.CreateResponse> {
    return this._callApi("createJob", async () => {
      return workspaceClient.jobs.create(request, this._createContext(signal));
    });
  }

  async waitForRun(
    workspaceClient: WorkspaceClient,
    runId: number,
    pollIntervalMs = 5000,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<jobs.Run> {
    const startTime = Date.now();
    const timeout = timeoutMs ?? this.config.timeout ?? 600000;

    return this.telemetry.startActiveSpan(
      "jobs.waitForRun",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "jobs.run_id": runId,
          "jobs.poll_interval_ms": pollIntervalMs,
          "jobs.timeout_ms": timeout,
        },
      },
      async (span: Span) => {
        try {
          let pollCount = 0;

          while (true) {
            pollCount++;
            const elapsed = Date.now() - startTime;

            if (elapsed > timeout) {
              throw ExecutionError.statementFailed(
                `Job run ${runId} polling timeout after ${timeout}ms`,
              );
            }

            if (signal?.aborted) {
              throw ExecutionError.canceled();
            }

            span.addEvent("poll.attempt", {
              "poll.count": pollCount,
              "poll.elapsed_ms": elapsed,
            });

            const run = await this.getRun(
              workspaceClient,
              { run_id: runId },
              signal,
            );

            const lifeCycleState = run.state?.life_cycle_state;

            if (
              lifeCycleState === "TERMINATED" ||
              lifeCycleState === "SKIPPED" ||
              lifeCycleState === "INTERNAL_ERROR"
            ) {
              span.setAttribute("jobs.final_state", lifeCycleState);
              span.setAttribute(
                "jobs.result_state",
                run.state?.result_state ?? "",
              );
              span.setAttribute("jobs.poll_count", pollCount);
              span.setStatus({ code: SpanStatusCode.OK });
              return run;
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof AppKitError) {
            throw error;
          }
          throw ExecutionError.statementFailed(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          span.end();
        }
      },
      { name: this.name, includePrefix: true },
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
          throw ExecutionError.statementFailed(
            error instanceof Error ? error.message : String(error),
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
        isCancellationRequested: signal?.aborted ?? false,
        onCancellationRequested: (cb: () => void) => {
          signal?.addEventListener("abort", cb, { once: true });
        },
      },
    });
  }
}

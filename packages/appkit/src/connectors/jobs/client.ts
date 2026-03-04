import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { Time, TimeUnits } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";
import { pollWaiter } from "../genie/poll-waiter";
import { jobsConnectorDefaults } from "./defaults";
import type {
  JobRunStreamEvent,
  JobRunSummary,
  JobsConnectorConfig,
  TaskRunSummary,
} from "./types";

const logger = createLogger("connectors:jobs");

export class JobsConnector {
  private readonly config: Required<JobsConnectorConfig>;

  constructor(config: JobsConnectorConfig = {}) {
    this.config = {
      timeout: config.timeout ?? jobsConnectorDefaults.timeout,
      maxRuns: config.maxRuns ?? jobsConnectorDefaults.maxRuns,
    };
  }

  /**
   * Trigger a job run and stream status updates until completion.
   * Yields events: run_start → status* → run_complete | error
   */
  async *streamRunJob(
    workspaceClient: WorkspaceClient,
    jobId: number,
    params?: {
      jobParameters?: Record<string, string>;
      notebookParams?: Record<string, string>;
      pythonNamedParams?: Record<string, string>;
      idempotencyToken?: string;
    },
    options?: { timeout?: number },
  ): AsyncGenerator<JobRunStreamEvent> {
    try {
      const waiter = await workspaceClient.jobs.runNow({
        job_id: jobId,
        job_parameters: params?.jobParameters,
        notebook_params: params?.notebookParams,
        python_named_params: params?.pythonNamedParams,
        idempotency_token: params?.idempotencyToken,
      });

      const runId = waiter.run_id;

      if (!runId) {
        yield { type: "error", error: "No run_id returned from runNow" };
        return;
      }

      yield { type: "run_start", runId, jobId };

      const timeout = options?.timeout ?? this.config.timeout;
      const waitOptions =
        timeout > 0
          ? { timeout: new Time(timeout, TimeUnits.milliseconds) }
          : {};

      let lastState: string | undefined;

      for await (const event of pollWaiter(waiter, waitOptions)) {
        if (event.type === "progress") {
          const run = event.value;
          const state =
            run.status?.state ?? run.state?.life_cycle_state ?? "UNKNOWN";

          if (state !== lastState) {
            lastState = state;
            yield {
              type: "status",
              lifeCycleState: state,
              stateMessage:
                run.state?.state_message ??
                run.status?.termination_details?.message,
            };
          }
        } else if (event.type === "completed") {
          const run = event.value;
          yield {
            type: "run_complete",
            runId,
            lifeCycleState:
              run.status?.state ?? run.state?.life_cycle_state ?? "TERMINATED",
            resultState: run.state?.result_state,
            stateMessage:
              run.state?.state_message ??
              run.status?.termination_details?.message,
          };
        }
      }
    } catch (error) {
      logger.error("Job run error: %O", error);
      yield {
        type: "error",
        error: error instanceof Error ? error.message : "Job run failed",
      };
    }
  }

  /**
   * Get the current status of a run.
   */
  async getRun(
    workspaceClient: WorkspaceClient,
    runId: number,
  ): Promise<JobRunSummary> {
    const run = await workspaceClient.jobs.getRun({ run_id: runId });
    return {
      runId: run.run_id ?? runId,
      jobId: run.job_id ?? 0,
      lifeCycleState:
        run.status?.state ?? run.state?.life_cycle_state ?? "UNKNOWN",
      resultState: run.state?.result_state,
      stateMessage:
        run.state?.state_message ?? run.status?.termination_details?.message,
      startTime: run.start_time,
      endTime: run.end_time,
      runDuration: run.run_duration,
      tasks: run.tasks?.map(
        (t): TaskRunSummary => ({
          taskKey: t.task_key,
          lifeCycleState:
            t.status?.state ?? t.state?.life_cycle_state ?? "UNKNOWN",
          resultState: t.state?.result_state,
          startTime: t.start_time,
          endTime: t.end_time,
        }),
      ),
    };
  }

  /**
   * Cancel a running job run.
   */
  async cancelRun(
    workspaceClient: WorkspaceClient,
    runId: number,
  ): Promise<void> {
    const waiter = await workspaceClient.jobs.cancelRun({ run_id: runId });
    await waiter.wait();
    logger.debug("Cancelled run %d", runId);
  }

  /**
   * List recent runs, optionally filtered by job ID.
   */
  async listRuns(
    workspaceClient: WorkspaceClient,
    options?: {
      jobId?: number;
      activeOnly?: boolean;
      completedOnly?: boolean;
      limit?: number;
    },
  ): Promise<JobRunSummary[]> {
    const limit = options?.limit ?? this.config.maxRuns;
    const runs: JobRunSummary[] = [];

    for await (const run of workspaceClient.jobs.listRuns({
      job_id: options?.jobId,
      active_only: options?.activeOnly,
      completed_only: options?.completedOnly,
      limit,
    })) {
      runs.push({
        runId: run.run_id ?? 0,
        jobId: run.job_id ?? 0,
        lifeCycleState:
          run.status?.state ?? run.state?.life_cycle_state ?? "UNKNOWN",
        resultState: run.state?.result_state,
        stateMessage:
          run.state?.state_message ?? run.status?.termination_details?.message,
        startTime: run.start_time,
        endTime: run.end_time,
        runDuration: run.run_duration,
      });

      if (runs.length >= limit) break;
    }

    return runs;
  }
}

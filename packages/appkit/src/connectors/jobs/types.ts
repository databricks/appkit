export interface JobsConnectorConfig {
  timeout?: number;
  maxRuns?: number;
}

export type JobRunStreamEvent =
  | { type: "run_start"; runId: number; jobId: number }
  | { type: "status"; lifeCycleState: string; stateMessage?: string }
  | {
      type: "run_complete";
      runId: number;
      lifeCycleState: string;
      resultState?: string;
      stateMessage?: string;
    }
  | { type: "error"; error: string };

export interface JobRunSummary {
  runId: number;
  jobId: number;
  lifeCycleState?: string;
  resultState?: string;
  stateMessage?: string;
  startTime?: number;
  endTime?: number;
  runDuration?: number;
  tasks?: TaskRunSummary[];
}

export interface TaskRunSummary {
  taskKey?: string;
  lifeCycleState?: string;
  resultState?: string;
  startTime?: number;
  endTime?: number;
}

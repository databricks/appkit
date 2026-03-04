import type { BasePluginConfig } from "shared";

export type { JobRunStreamEvent, JobRunSummary } from "../../connectors/jobs";

export interface IJobsConfig extends BasePluginConfig {
  /**
   * Map of alias → Databricks Job ID.
   * Allows triggering jobs by friendly name instead of numeric ID.
   *
   * @example { "etl-pipeline": 12345, "ml-training": 67890 }
   */
  jobs?: Record<string, number>;

  /** Run polling timeout in ms. Default: 600000 (10 min). Set to 0 for indefinite. */
  timeout?: number;
}

export interface TriggerJobRequest {
  jobParameters?: Record<string, string>;
  notebookParams?: Record<string, string>;
  pythonNamedParams?: Record<string, string>;
  idempotencyToken?: string;
}

import type { BasePluginConfig } from "shared";

/** Configuration for the Eval Pipeline plugin. */
export interface IEvalConfig extends BasePluginConfig {
  /** UC Volume path for eval artifacts. */
  appsVolume?: string;
  /** MLflow experiment path for logging aggregate results. */
  mlflowExperiment?: string;
  /** Timeout for volume I/O operations in milliseconds. Default: 60000 */
  timeout?: number;
}

/** File naming convention for eval artifacts on UC Volumes. */
export interface EvalArtifactPaths {
  /** Generated app zip: run_{runId}_{appName}.zip */
  appZip(runId: string, appName: string): string;
  /** Eval result: run_{runId}_{appName}_eval.pb */
  evalResult(runId: string, appName: string): string;
  /** Edited app zip: run_{runId}_{editName}_{appName}.zip */
  editedAppZip(runId: string, editName: string, appName: string): string;
  /** Edit eval result: run_{runId}_{editName}_{appName}_edit_eval.pb */
  editEvalResult(runId: string, editName: string, appName: string): string;
  /** Generation result: run_{runId}_{appName}_gen.pb */
  generationResult(runId: string, appName: string): string;
  /** Aggregate report: run_{runId}_aggregate.pb */
  aggregateReport(runId: string): string;
  /** Trajectory: run_{runId}_{appName}_trajectory.pb */
  trajectory(runId: string, appName: string): string;
  /** Pipeline config: run_{runId}_config.pb */
  pipelineConfig(runId: string): string;
}

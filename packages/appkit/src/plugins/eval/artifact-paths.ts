import type { EvalArtifactPaths } from "./types";

/**
 * Creates path resolvers for eval artifacts on a UC Volume.
 *
 * Follows the naming convention from apps-mcp-evals:
 * - Zips: run_{runId}_{appName}.zip
 * - Proto results: run_{runId}_{appName}_{stage}.pb
 *
 * Proto (.pb) files replace the JSON files used in the Python pipeline,
 * enabling typed binary serialization between pipeline stages.
 */
export function createArtifactPaths(volumeBase: string): EvalArtifactPaths {
  const base = volumeBase.replace(/\/$/, "");

  return {
    appZip: (runId, appName) =>
      `${base}/run_${runId}_${appName}.zip`,

    evalResult: (runId, appName) =>
      `${base}/run_${runId}_${appName}_eval.pb`,

    editedAppZip: (runId, editName, appName) =>
      `${base}/run_${runId}_${editName}_${appName}.zip`,

    editEvalResult: (runId, editName, appName) =>
      `${base}/run_${runId}_${editName}_${appName}_edit_eval.pb`,

    generationResult: (runId, appName) =>
      `${base}/run_${runId}_${appName}_gen.pb`,

    aggregateReport: (runId) =>
      `${base}/run_${runId}_aggregate.pb`,

    trajectory: (runId, appName) =>
      `${base}/run_${runId}_${appName}_trajectory.pb`,

    pipelineConfig: (runId) =>
      `${base}/run_${runId}_config.pb`,
  };
}

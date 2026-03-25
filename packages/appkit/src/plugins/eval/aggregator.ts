import { createLogger } from "../../logging/logger";
import type {
  AggregateMetrics,
  AggregateReport,
  EditEvalResult,
  EvalResult,
} from "shared/proto";

const logger = createLogger("eval:aggregator");

/**
 * Computes the appeval_100 score from eval metrics.
 *
 * 6 equal components (each 0 or 1, except runability which is 0-1):
 * build_success + unit_tests + smoke_tests + type_safety + local_runability + apps_validate
 * Divided by 6.
 */
export function computeAppeval100(metrics: {
  buildSuccess: boolean;
  unitTestsPass: boolean;
  smokeTestsPass: boolean;
  typeSafetyPass: boolean;
  localRunability: number;
  appsValidatePass: boolean;
}): number {
  const sum =
    (metrics.buildSuccess ? 1.0 : 0.0) +
    (metrics.unitTestsPass ? 1.0 : 0.0) +
    (metrics.smokeTestsPass ? 1.0 : 0.0) +
    (metrics.typeSafetyPass ? 1.0 : 0.0) +
    metrics.localRunability +
    (metrics.appsValidatePass ? 1.0 : 0.0);

  return sum / 6.0;
}

/**
 * Computes the appedit_100 score from edit eval results.
 *
 * (total_edits - build_regressions - test_regressions) / total_edits
 */
export function computeAppedit100(
  totalEdits: number,
  buildRegressions: number,
  testRegressions: number,
): number {
  if (totalEdits === 0) return 0;
  return (totalEdits - buildRegressions - testRegressions) / totalEdits;
}

/**
 * Aggregates eval and edit-eval results into a single AggregateMetrics object.
 *
 * Mirrors the logic in aggregate_results.py: deduplicates by app name,
 * keeps highest appeval_100, and computes all summary metrics.
 */
export function aggregateResults(
  evalResults: EvalResult[],
  editEvalResults: EditEvalResult[],
  totalExpected: number,
  totalGenerated: number,
): Partial<AggregateMetrics> {
  // Deduplicate eval results by app name, keep highest appeval_100
  const dedupMap = new Map<string, EvalResult>();
  for (const result of evalResults) {
    const normalized = result.appName.replace(/-/g, "_");
    const existing = dedupMap.get(normalized);
    if (
      !existing ||
      (result.metrics?.appeval100 ?? 0) > (existing.metrics?.appeval100 ?? 0)
    ) {
      dedupMap.set(normalized, result);
    }
  }
  const deduped = Array.from(dedupMap.values());

  // Compute eval aggregate metrics
  const totalApps = deduped.length;
  const buildSuccessCount = deduped.filter((r) => r.metrics?.buildSuccess).length;
  const unitTestsPassCount = deduped.filter((r) => r.metrics?.unitTestsPass).length;
  const smokeTestsPassCount = deduped.filter((r) => r.metrics?.smokeTestsPass).length;
  const typeSafetyPassCount = deduped.filter((r) => r.metrics?.typeSafetyPass).length;
  const appsValidatePassCount = deduped.filter((r) => r.metrics?.appsValidatePass).length;

  const avgAppeval100 =
    totalApps > 0
      ? deduped.reduce((sum, r) => sum + (r.metrics?.appeval100 ?? 0), 0) / totalApps
      : 0;

  const localRunabilityAvg =
    totalApps > 0
      ? deduped.reduce((sum, r) => sum + (r.metrics?.localRunability ?? 0), 0) / totalApps
      : 0;

  const avgBuildTimeSec =
    totalApps > 0
      ? deduped.reduce((sum, r) => sum + (r.metrics?.buildTimeSec ?? 0), 0) / totalApps
      : 0;

  // Generation metrics from attached generation_metrics
  const withGen = deduped.filter((r) => r.generationMetrics);
  const totalGenTokens = withGen.reduce(
    (sum, r) =>
      sum +
      Number(r.generationMetrics?.inputTokens ?? 0n) +
      Number(r.generationMetrics?.outputTokens ?? 0n),
    0,
  );
  const totalGenCostUsd = withGen.reduce(
    (sum, r) => sum + (r.generationMetrics?.costUsd ?? 0),
    0,
  );
  const avgGenTimeSec =
    withGen.length > 0
      ? withGen.reduce((sum, r) => sum + (r.generationMetrics?.generationTimeSec ?? 0), 0) /
        withGen.length
      : 0;
  const avgGenTurns =
    withGen.length > 0
      ? withGen.reduce((sum, r) => sum + (r.generationMetrics?.turns ?? 0), 0) / withGen.length
      : 0;

  // Edit metrics
  const totalEdits = editEvalResults.length;
  const editBuildRegressions = editEvalResults.filter(
    (r) => r.regression?.buildRegressed,
  ).length;
  const editTestRegressions = editEvalResults.filter(
    (r) => r.regression?.testsRegressed,
  ).length;
  const avgEditAppevalDelta =
    totalEdits > 0
      ? editEvalResults.reduce(
          (sum, r) => sum + (r.regression?.appevalDelta ?? 0),
          0,
        ) / totalEdits
      : 0;
  const editNoChangeCount = editEvalResults.filter(
    (r) => r.regression?.noChangesMade,
  ).length;

  const withEditMetrics = editEvalResults.filter((r) => r.editMetrics);
  const totalEditCostUsd = withEditMetrics.reduce(
    (sum, r) => sum + (r.editMetrics?.costUsd ?? 0),
    0,
  );
  const avgEditTimeSec =
    withEditMetrics.length > 0
      ? withEditMetrics.reduce(
          (sum, r) => sum + (r.editMetrics?.editTimeSec ?? 0),
          0,
        ) / withEditMetrics.length
      : 0;
  const avgEditTurns =
    withEditMetrics.length > 0
      ? withEditMetrics.reduce(
          (sum, r) => sum + (r.editMetrics?.turns ?? 0),
          0,
        ) / withEditMetrics.length
      : 0;

  // UI checks
  const uiResults = editEvalResults.filter((r) => r.uiVerification && !r.uiVerification.skipped);
  const editUiChecksRun = uiResults.length;
  const editUiChecksPass = uiResults.filter((r) => r.uiVerification?.uiCheckPass).length;

  // Complexity
  const withComplexity = editEvalResults.filter((r) => r.complexity);
  const editAvgSimplificationScore =
    withComplexity.length > 0
      ? withComplexity.reduce(
          (sum, r) => sum + (r.complexity?.simplificationScore ?? 0),
          0,
        ) / withComplexity.length
      : 0;

  logger.info(
    "Aggregated %d eval results, %d edit results → avg_appeval_100=%.3f",
    totalApps,
    totalEdits,
    avgAppeval100,
  );

  return {
    totalExpectedApps: totalExpected,
    totalGenerated,
    totalApps,
    generationFailures: totalExpected - totalGenerated,
    avgAppeval100,
    buildSuccessCount,
    unitTestsPassCount,
    smokeTestsPassCount,
    typeSafetyPassCount,
    appsValidatePassCount,
    localRunabilityAvg,
    avgEffUnits: withGen.length > 0 ? totalGenTokens / withGen.length : 0,
    avgGenTurns,
    totalGenCostUsd,
    avgGenCostUsd: withGen.length > 0 ? totalGenCostUsd / withGen.length : 0,
    totalGenTokens: BigInt(totalGenTokens),
    avgGenTimeSec,
    avgBuildTimeSec,
    appedit100: computeAppedit100(totalEdits, editBuildRegressions, editTestRegressions),
    totalEdits,
    editBuildRegressions,
    editTestRegressions,
    avgEditAppevalDelta,
    editNoChangeCount,
    totalEditCostUsd,
    avgEditCostUsd: withEditMetrics.length > 0 ? totalEditCostUsd / withEditMetrics.length : 0,
    avgEditTimeSec,
    avgEditTurns,
    editUiChecksRun,
    editUiChecksPass,
    editUiCheckRate: editUiChecksRun > 0 ? editUiChecksPass / editUiChecksRun : 0,
    editAvgSimplificationScore,
  };
}

import { getErrorDiagnostic, isConnectivityError } from "../errors";
import type { DatabricksStatementExecutionResponse } from "../types";
import {
  extractMetricColumns,
  parseDescribeTableExtendedJson,
} from "./describe";
import type {
  DescribeFetcher,
  MetricColumnMetadata,
  MetricConfigResolution,
  MetricSchema,
  MetricSyncFailure,
  MetricSyncResult,
  ResolvedMetricEntry,
} from "./types";

/**
 * Build the degraded schema emitted when an entry's columns are not
 * available — same key/source/lane as a real schema, with empty
 * measure/dimension allowlists and `degraded: true`.
 */
export function emptyMetricSchema(
  entry: Pick<MetricSchema, "key" | "source" | "lane">,
): MetricSchema {
  return {
    key: entry.key,
    source: entry.source,
    lane: entry.lane,
    measures: [],
    dimensions: [],
    degraded: true,
  };
}

// Maximum number of in-flight DESCRIBE statements per syncMetrics pass.
const MV_DESCRIBE_CONCURRENCY = 10;

// Outcome of describing a single metric entry.
interface MetricDescribeOutcome {
  index: number;
  schema: MetricSchema;
  failure?: MetricSyncFailure;
}

/**
 * Run schema synchronization for every entry in {@link import("./config").MV_CONFIG_FILE}.
 */
export async function syncMetrics(
  resolution: MetricConfigResolution,
  fetcher: DescribeFetcher,
): Promise<MetricSyncResult> {
  const { entries } = resolution;
  const schemas = new Array<MetricSchema>(entries.length);
  const failureSlots = new Array<MetricSyncFailure | undefined>(entries.length);

  const failedOutcome = (
    index: number,
    entry: ResolvedMetricEntry,
    reason: string,
    transient: boolean,
  ): MetricDescribeOutcome => ({
    index,
    schema: emptyMetricSchema(entry),
    failure: { key: entry.key, source: entry.source, reason, transient },
  });

  const describeOne = async (
    entry: ResolvedMetricEntry,
    index: number,
  ): Promise<MetricDescribeOutcome> => {
    let response: DatabricksStatementExecutionResponse;
    try {
      response = await fetcher(entry.source);
    } catch (err) {
      const reason = `DESCRIBE TABLE EXTENDED failed: ${getErrorDiagnostic(err)}`;
      // Connectivity blips self-converge (retry next pass); auth, a bad
      // warehouse id, a truncated / multi-chunk result, or a malformed request
      // are deterministic and must surface — the same split the query path makes.
      return failedOutcome(index, entry, reason, isConnectivityError(err));
    }

    const state = response.status?.state;
    if (state !== "SUCCEEDED" && state !== "FAILED") {
      return { index, schema: emptyMetricSchema(entry) };
    }

    let columns: MetricColumnMetadata[];
    try {
      const parsed = parseDescribeTableExtendedJson(response);
      columns = extractMetricColumns(parsed);
    } catch (err) {
      const reason = `Failed to extract columns from DESCRIBE response: ${(err as Error).message}`;
      return failedOutcome(index, entry, reason, false);
    }

    if (columns.length === 0) {
      const reason =
        "DESCRIBE response yielded zero columns — check the response shape (top-level `columns` array or `schema.fields`).";
      return failedOutcome(index, entry, reason, false);
    }

    const measures = columns.filter((c) => c.isMeasure);
    const dimensions = columns.filter((c) => !c.isMeasure);

    return {
      index,
      schema: {
        key: entry.key,
        source: entry.source,
        lane: entry.lane,
        measures,
        dimensions,
      },
    };
  };

  for (
    let offset = 0;
    offset < entries.length;
    offset += MV_DESCRIBE_CONCURRENCY
  ) {
    const slice = entries.slice(offset, offset + MV_DESCRIBE_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((entry, i) => describeOne(entry, offset + i)),
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        const { index, schema, failure } = result.value;
        schemas[index] = schema;
        if (failure) {
          failureSlots[index] = failure;
        }
      } else {
        const index = offset + i;
        const entry = entries[index];
        const { schema, failure } = failedOutcome(
          index,
          entry,
          `DESCRIBE TABLE EXTENDED failed: ${getErrorDiagnostic(result.reason)}`,
          isConnectivityError(result.reason),
        );
        schemas[index] = schema;
        failureSlots[index] = failure;
      }
    }
  }

  const failures = failureSlots.filter(
    (failure): failure is MetricSyncFailure => failure !== undefined,
  );

  return { schemas, failures };
}

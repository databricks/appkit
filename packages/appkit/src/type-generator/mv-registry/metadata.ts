import { compareKeys } from "./config";
import type { MetricColumnMetadata, MetricSchema } from "./types";

interface MetricColumnSemanticMetadata {
  type: string;
  display_name?: string;
  format?: string;
  description?: string;
  /** Only emitted on dimension entries that resolved to a TIMESTAMP* or DATE SQL type. */
  time_grain?: readonly string[];
}

interface MetricSemanticMetadataEntry {
  measures: Record<string, MetricColumnSemanticMetadata>;
  dimensions: Record<string, MetricColumnSemanticMetadata>;
}

type MetricsMetadataBundle = Record<string, MetricSemanticMetadataEntry>;

/**
 * Converts a list of metric schemas into a JSON metadata bundle.
 */
export function buildMetricsMetadataBundle(
  schemas: MetricSchema[],
): MetricsMetadataBundle {
  // Null-prototype maps: metric keys and column names are controlled outside
  // this package, and "__proto__" is legal input.
  const bundle: MetricsMetadataBundle = Object.create(null);
  const sortedSchemas = [...schemas].sort((a, b) => compareKeys(a.key, b.key));

  for (const schema of sortedSchemas) {
    const measures: Record<string, MetricColumnSemanticMetadata> =
      Object.create(null);
    for (const m of schema.measures) {
      measures[m.name] = buildColumnMetadata(m);
    }

    const dimensions: Record<string, MetricColumnSemanticMetadata> =
      Object.create(null);
    for (const d of schema.dimensions) {
      dimensions[d.name] = buildColumnMetadata(d);
    }

    bundle[schema.key] = {
      measures,
      dimensions,
    };
  }

  return bundle;
}

function buildColumnMetadata(
  col: MetricColumnMetadata,
): MetricColumnSemanticMetadata {
  const entry: MetricColumnSemanticMetadata = { type: col.type };
  if (col.displayName) entry.display_name = col.displayName;
  if (col.format) entry.format = col.format;
  if (col.description) entry.description = col.description;
  if (!col.isMeasure && col.timeGrains && col.timeGrains.length > 0) {
    entry.time_grain = [...col.timeGrains];
  }
  return entry;
}

/**
 * Serialize the metadata bundle to a stable, human-readable JSON string.
 */
export function generateMetricsMetadataJson(schemas: MetricSchema[]): string {
  const bundle = buildMetricsMetadataBundle(schemas);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

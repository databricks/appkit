import { z } from "zod";
import { metricKeySchema } from "./metric-source";

// Bundle format version.
export const METRIC_METADATA_BUNDLE_VERSION = 1;
export const METRIC_METADATA_FILE = "metadata.generated.json";

const columnDisplaySchema = z
  .object({
    type: z
      .string()
      .describe("SQL type of the column as reported by DESCRIBE."),
    display_name: z
      .string()
      .optional()
      .describe("Human label from the metric view's YAML `display_name`."),
    format: z
      .string()
      .optional()
      .describe(
        'Spark number-format spec from the metric view\'s YAML `format`, e.g. "$#,##0.00".',
      ),
    description: z
      .string()
      .optional()
      .describe("Column description from the metric view's YAML."),
  })
  // Non-strict: a newer generator may add per-column fields, and an older
  // runtime should keep serving the fields it does understand rather than
  // rejecting the whole bundle over one unknown key.
  .describe("Display metadata for a single metric-view column.");

const metricEntryMetadataSchema = z
  .object({
    measures: z.record(z.string(), columnDisplaySchema),
    dimensions: z.record(z.string(), columnDisplaySchema),
  })
  .describe("Per-column display metadata for one metric view.");

export const metricMetadataBundleSchema = z
  .object({
    version: z
      .number()
      .int()
      .describe(
        "Bundle format version. Compared against METRIC_METADATA_BUNDLE_VERSION.",
      ),
    metricViews: z
      .record(metricKeySchema, metricEntryMetadataSchema)
      .describe("Per-column display metadata, keyed by metric key."),
  })
  .describe(
    "Schema for AppKit config/metric-views/metadata.generated.json — build-generated per-column display metadata for the analytics plugin's metric-view path. Generated; do not hand-edit.",
  );

export type MetricMetadataBundle = z.infer<typeof metricMetadataBundleSchema>;

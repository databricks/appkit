/**
 * AppKit metric-metadata bundle schema.
 *
 * Single source of truth for `config/metric-views/metadata.generated.json` —
 * the build-generated companion to the hand-authored `definitions.json`.
 *
 * The type generator derives per-column display metadata (`display_name`,
 * `format`, SQL `type`, `description`) from `DESCRIBE TABLE EXTENDED` and writes
 * it here as a value the server can read at runtime. It lives in a separate file
 * from `definitions.json` because that file is user-authored: a generator that
 * wrote into it would clobber hand edits on every regeneration.
 *
 * Validated at both ends — the generator serializes against this schema and the
 * analytics plugin parses with it — so a bundle the generator can write is a
 * bundle the runtime can read.
 */

import { z } from "zod";
import { metricKeySchema } from "./metric-source";

/**
 * Bundle format version. Bumped only for a breaking shape change, so a runtime
 * reading a bundle from a newer generator can say so instead of silently
 * mis-parsing a shape it does not understand.
 */
export const METRIC_METADATA_BUNDLE_VERSION = 1;

/** Basename of the generated bundle inside `config/metric-views/`. */
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

/**
 * Zod-authoring module for the AppKit metric-source schema.
 *
 * Single source of truth for `metric.json` — the opt-in config that activates
 * the analytics plugin's metric-view path. The JSON Schema artifact published
 * at the docs URL is emitted from this schema via
 * `tools/generate-json-schema.ts` and lives only in `docs/static/schemas/`
 * (no package-internal copies).
 *
 * `metric.json` declares Unity Catalog Metric View sources. Each entry under
 * `sp`/`obo` binds a metric key to a UC metric view FQN:
 * - `sp` entries are queried as the service principal (cache scope shared
 *   across all users).
 * - `obo` entries are queried as the requesting user (on-behalf-of; cache
 *   scope per-user).
 *
 * Entries are objects (rather than bare strings) at v1 so future per-entry
 * options (cacheTtl, defaultFilter, allowlists) can ship as additive
 * properties without a breaking change.
 */

import { z } from "zod";

// ── Metric key ───────────────────────────────────────────────────────────

export const metricKeySchema = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .describe(
    "Metric key. Must be a valid identifier (letters, digits, underscores; cannot start with a digit). Becomes the route key in POST /api/analytics/metric/:key, the hook argument in useMetricView('<key>', ...), and the MetricRegistry augmentation key.",
  );

// ── Metric entry (single source declaration) ─────────────────────────────

export const metricEntrySchema = z
  .object({
    source: z
      .string()
      .regex(
        /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*$/,
      )
      .describe(
        "Three-part Unity Catalog FQN of the metric view: <catalog>.<schema>.<metric_view>",
      )
      .meta({
        examples: [
          "appkit_demo.public.revenue_metrics",
          "main.analytics.customer_metrics",
        ],
      }),
  })
  .strict()
  .describe(
    "A single metric view source declaration. v1 only accepts the 'source' field; future per-entry options (cacheTtl, defaultFilter, allowlists) ship as additive properties.",
  );

// ── Metric source config (root) ──────────────────────────────────────────

export const metricSourceSchema = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe("Reference to the JSON Schema for validation"),
    sp: z
      .record(metricKeySchema, metricEntrySchema)
      .optional()
      .describe(
        "Metric views queried as the service principal. Cache scope is shared across all users.",
      ),
    obo: z
      .record(metricKeySchema, metricEntrySchema)
      .optional()
      .describe(
        "Metric views queried as the requesting user (on-behalf-of). Cache scope is per-user.",
      ),
  })
  .strict()
  .describe(
    "Schema for AppKit metric.json — declares Unity Catalog Metric View sources for the analytics plugin's metric-view path. Each entry under sp/obo binds a metric key to a UC metric view FQN. Object form (rather than bare string) at v1 enables future per-entry option growth without breaking changes.",
  );

// ── Inferred types ───────────────────────────────────────────────────────

export type MetricKey = z.infer<typeof metricKeySchema>;
export type MetricEntry = z.infer<typeof metricEntrySchema>;
export type MetricSource = z.infer<typeof metricSourceSchema>;

/**
 * AppKit metric-source schema.
 *
 * Single source of truth for `metric-views.json`
 * the config that activates the Analytics' metric-view path.
 *
 * `metric-views.json` declares UC Metric Views under a single `metricViews` map.
 * Each entry binds a metric key to a UC metric view FQN plus the executor
 * the query runs as:
 * - `executor: "app_service_principal"` (default) — queried as the app service
 *   principal (cache scope shared across all users).
 * - `executor: "user"` — queried as the requesting user (on-behalf-of;
 *   cache scope per-user).
 *
 * A single map (rather than per-executor sections) makes metric keys unique
 * by construction — the same key cannot be declared twice with different
 * executors.
 */

import { z } from "zod";
import { UC_FQN_PATTERN } from "./metric-fqn";

/**
 * Three-part Unity Catalog FQN matcher, composed from the single-segment
 * {@link UC_FQN_PATTERN} so the per-segment grammar has exactly one source of
 * truth (shared by the type-generator runtime, which imports the zod-free
 * {@link UC_FQN_PATTERN} directly — see `./metric-fqn.ts`).
 *
 * `UC_FQN_PATTERN` is `^<segment>+$`; stripping its `^`/`$` anchors yields the
 * per-segment sub-pattern, which is joined with literal dots into
 * `^<segment>\.<segment>\.<segment>$`. Exactly three dot-separated segments,
 * each a valid UC object name. Arity (and the per-segment length cap) is also
 * enforced structurally by the type-generator's `resolveMetricConfig`.
 */
const UC_FQN_SEGMENT_SOURCE = UC_FQN_PATTERN.source
  .replace(/^\^/, "")
  .replace(/\$$/, "");
const UC_THREE_PART_FQN_PATTERN = new RegExp(
  `^${UC_FQN_SEGMENT_SOURCE}\\.${UC_FQN_SEGMENT_SOURCE}\\.${UC_FQN_SEGMENT_SOURCE}$`,
);

export const metricKeySchema = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .describe(
    "Metric key. Must be a valid identifier (letters, digits, underscores; cannot start with a digit). Becomes the route key in POST /api/analytics/metric/:key, the hook argument in useMetricView('<key>', ...), and the MetricRegistry augmentation key.",
  );

export const metricExecutorSchema = z
  .enum(["app_service_principal", "user"])
  .describe(
    "Who the metric view is queried as. 'app_service_principal' (default) runs as the app service principal with a cache shared across all users; 'user' runs on-behalf-of the requesting user with a per-user cache.",
  );

/**
 * @note Entries are objects (rather than bare strings) at v1 so future per-entry
 * options (cacheTtl, defaultFilter, allowlists) can ship as additive
 * properties without a breaking change. `executor` is the first such option.
 */
export const metricEntrySchema = z
  .object({
    source: z
      .string()
      .regex(UC_THREE_PART_FQN_PATTERN)
      .describe(
        "Three-part Unity Catalog FQN of the metric view: <catalog>.<schema>.<metric_view>",
      )
      .meta({
        examples: [
          "appkit_demo.public.revenue_metrics",
          "main.analytics.customer_metrics",
        ],
      }),
    executor: metricExecutorSchema.default("app_service_principal"),
  })
  .strict()
  .describe(
    "A single metric view source declaration: the UC FQN to query and the executor to query it as. Future per-entry options (cacheTtl, defaultFilter, allowlists) ship as additive properties.",
  );

export const metricSourceSchema = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe("Reference to the JSON Schema for validation"),
    metricViews: z
      .record(metricKeySchema, metricEntrySchema)
      .optional()
      .describe(
        "Metric view declarations, keyed by metric key. Each entry names the UC metric view to query and the executor it runs as.",
      ),
  })
  .strict()
  .describe(
    "Schema for AppKit metric-views.json — declares Unity Catalog Metric View sources for the analytics plugin's metric-view path. Each entry under 'metricViews' binds a metric key to a UC metric view FQN and an executor ('app_service_principal' shared cache, or 'user' per-user cache). Object form (rather than bare string) at v1 enables future per-entry option growth without breaking changes.",
  );

export type MetricKey = z.infer<typeof metricKeySchema>;
export type MetricExecutor = z.infer<typeof metricExecutorSchema>;
export type MetricEntry = z.infer<typeof metricEntrySchema>;
export type MetricSource = z.infer<typeof metricSourceSchema>;

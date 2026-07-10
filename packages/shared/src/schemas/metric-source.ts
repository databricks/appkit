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
import { MAX_UC_OBJECT_NAME_LENGTH, UC_FQN_PATTERN } from "./metric-fqn";

/**
 * Safety cap on the number of declared metric views — a typo / DoS guard, NOT
 * a Unity Catalog limit. Mirrors the type-generator's `MAX_METRIC_VIEWS` so
 * runtime config validation and type generation accept exactly the same
 * configs (a config that fails generation must not silently pass at runtime).
 */
const MAX_METRIC_VIEWS = 200;

/**
 * Whole-FQN length cap: three max-length UC object names plus the two dots.
 * The per-segment cap ({@link MAX_UC_OBJECT_NAME_LENGTH}) is enforced in the
 * `superRefine` below; this whole-string bound is the declarative half (it
 * serializes to a JSON-schema `maxLength`, whereas the per-segment check — like
 * the entry-count cap — cannot be expressed declaratively and lives in the
 * refinement, so it is a runtime/type-generator gate only).
 */
const MAX_FQN_LENGTH = MAX_UC_OBJECT_NAME_LENGTH * 3 + 2;

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
      .max(MAX_FQN_LENGTH)
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
  )
  // Caps that cannot be expressed declaratively (zod 4's `z.record` has no
  // `.max`, and a per-dot-segment length bound isn't a whole-string
  // `maxLength`). Enforced here so runtime config validation matches the
  // type-generator's `resolveMetricConfig` exactly — a config that fails type
  // generation must not silently pass at runtime. These refinements are
  // invisible to `z.toJSONSchema`, so the generated JSON schema carries only
  // the declarative `maxLength` on `source`; runtime + type-generator remain
  // the authoritative gates for the entry-count and per-segment caps.
  .superRefine((value, ctx) => {
    const entries = value.metricViews ? Object.entries(value.metricViews) : [];

    if (entries.length > MAX_METRIC_VIEWS) {
      ctx.addIssue({
        code: "custom",
        message: `too many metric views: ${entries.length} declared, exceeding the maximum of ${MAX_METRIC_VIEWS}`,
        path: ["metricViews"],
      });
    }

    for (const [key, entry] of entries) {
      const segments = entry.source.split(".");
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].length > MAX_UC_OBJECT_NAME_LENGTH) {
          ctx.addIssue({
            code: "custom",
            message: `metric source segment ${i + 1} is ${segments[i].length} characters, exceeding the per-segment maximum of ${MAX_UC_OBJECT_NAME_LENGTH}`,
            path: ["metricViews", key, "source"],
          });
        }
      }
    }
  });

export type MetricKey = z.infer<typeof metricKeySchema>;
export type MetricExecutor = z.infer<typeof metricExecutorSchema>;
export type MetricEntry = z.infer<typeof metricEntrySchema>;
export type MetricSource = z.infer<typeof metricSourceSchema>;

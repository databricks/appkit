import {
  type MetricSource,
  metricSourceSchema,
} from "../../../schemas/metric-source";

/**
 * A single metric-source validation issue. `path` is a humanized property path
 * (e.g. `metricViews.revenue.source`) suitable for direct CLI output, and
 * `message` is the schema's own diagnostic. Mirrors the `SemanticIssue` shape
 * used by the plugin-manifest validator so CLI output stays uniform across
 * commands.
 */
export interface MetricViewsSourceIssue {
  path: string;
  message: string;
}

/** Result of {@link validateMetricViewsSource}. */
export type ValidateMetricViewsSourceResult =
  | { valid: true; source: MetricSource }
  | { valid: false; errors: MetricViewsSourceIssue[] };

/**
 * Humanize a Zod issue path (array of object keys / array indices) into a
 * single string like `metricViews.revenue.source`. Numeric segments render as
 * `[n]`; an empty path (a root-level issue, e.g. an unrecognized top-level key)
 * renders as `(root)`. Mirrors `humanizePath` in the plugin-manifest validator.
 */
export function humanizeMetricViewsPath(
  path: ReadonlyArray<PropertyKey> | undefined,
): string {
  if (!path || path.length === 0) return "(root)";

  let out = "";
  for (const key of path) {
    if (typeof key === "number") {
      out += `[${key}]`;
    } else {
      const str = String(key);
      out += out.length === 0 ? str : `.${str}`;
    }
  }
  return out.length === 0 ? "(root)" : out;
}

/**
 * Validate a parsed `metric-views.json` object against the canonical
 * {@link metricSourceSchema}. The schema is the single source of truth (it also
 * backs the generated JSON schema and the type-generator runtime); this helper
 * only adapts its `safeParse` result into a CLI-friendly issue list.
 *
 * On success the original input is returned (typed as {@link MetricSource}),
 * not a re-emitted copy.
 */
export function validateMetricViewsSource(
  obj: unknown,
): ValidateMetricViewsSourceResult {
  const result = metricSourceSchema.safeParse(obj);
  if (result.success) {
    return { valid: true, source: result.data };
  }
  const errors = result.error.issues.map((issue) => ({
    path: humanizeMetricViewsPath(issue.path as ReadonlyArray<PropertyKey>),
    message: issue.message,
  }));
  return { valid: false, errors };
}

/**
 * Format metric-source validation issues for CLI output. Each issue renders on
 * its own line indented by two spaces as `  <path>: <message>`. Mirrors
 * `formatValidationErrors` in the plugin-manifest validator so the two commands
 * present schema errors identically.
 */
export function formatMetricViewsSourceErrors(
  issues: MetricViewsSourceIssue[],
): string {
  return issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n");
}

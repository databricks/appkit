import { z } from "zod";
import { isValidColumnName } from "../../../../../shared/src/schemas/metric-fqn";
import { ValidationError } from "../../../errors";
import type {
  IAnalyticsMetricRequest,
  MetricFilter,
  MetricFilterOperatorName,
  MetricPredicate,
} from "../types";
import { normalizeAnalyticsFormat } from "../types";
import {
  LIST_VALUE_OPERATORS,
  METRIC_DIMENSIONS_MAX,
  METRIC_FILTER_GROUP_MAX,
  METRIC_FILTER_MAX_DEPTH,
  METRIC_FILTER_OPERATORS,
  METRIC_FILTER_VALUES_MAX,
  METRIC_LIMIT_MAX,
  METRIC_MEASURES_MAX,
  METRIC_ORDER_BY_MAX,
  METRIC_ORDER_DIRECTIONS,
  NULL_OPERATORS,
  SINGLE_VALUE_OPERATORS,
  STRING_OPERATORS,
  TIME_GRAIN_PATTERN,
} from "./constants";

/** A leaf predicate: `{ member, operator, values? }`, no extra keys. */
const filterPredicateSchema: z.ZodType<MetricPredicate> = z
  .object({
    member: z
      .string()
      .min(1, { message: "filter predicate 'member' cannot be empty" })
      .refine(isValidColumnName, {
        message:
          "filter predicate 'member' contains a character that cannot be used in a SQL identifier (control character or newline)",
      }),
    operator: z.string().min(1, {
      message: "filter predicate 'operator' cannot be empty",
    }) as z.ZodType<MetricFilterOperatorName>,
    values: z
      .array(z.union([z.string(), z.number()]))
      .max(METRIC_FILTER_VALUES_MAX, {
        message: `filter predicate 'values' length exceeds the maximum of ${METRIC_FILTER_VALUES_MAX}`,
      })
      .optional(),
  })
  .strict();

/** Recursive filter: a predicate leaf or an `{ and }` / `{ or }` group. */
const filterSchema: z.ZodType<MetricFilter> = z.lazy(() =>
  z.union([
    filterPredicateSchema,
    z
      .object({
        and: z.array(filterSchema).max(METRIC_FILTER_GROUP_MAX, {
          message: `filter 'and' group exceeds the maximum of ${METRIC_FILTER_GROUP_MAX} children`,
        }),
      })
      .strict(),
    z
      .object({
        or: z.array(filterSchema).max(METRIC_FILTER_GROUP_MAX, {
          message: `filter 'or' group exceeds the maximum of ${METRIC_FILTER_GROUP_MAX} children`,
        }),
      })
      .strict(),
  ]),
);

const metricRequestSchema = z
  .object({
    measures: z
      .array(
        z
          .string()
          .min(1, "measure name cannot be empty")
          .refine(isValidColumnName, {
            message:
              "measure name contains a character that cannot be used in a SQL identifier (control character or newline)",
          }),
      )
      .min(1, "at least one measure is required")
      .max(METRIC_MEASURES_MAX, {
        message: `measures length exceeds the maximum of ${METRIC_MEASURES_MAX}`,
      }),
    dimensions: z
      .array(
        z
          .string()
          .min(1, "dimension name cannot be empty")
          .refine(isValidColumnName, {
            message:
              "dimension name contains a character that cannot be used in a SQL identifier (control character or newline)",
          }),
      )
      .max(METRIC_DIMENSIONS_MAX, {
        message: `dimensions length exceeds the maximum of ${METRIC_DIMENSIONS_MAX}`,
      })
      .optional(),
    filter: filterSchema.optional(),
    // Grammar-shaped bucketing grain, applied to `timeDimension` via
    // `date_trunc`. The token is validated for safety here; the grain literal
    // is interpolated (single-quoted, never a bind param) in
    // `renderDimensionClause`, so this pattern gate is the security boundary.
    timeGrain: z
      .string()
      .min(1, { message: "timeGrain cannot be empty" })
      .regex(TIME_GRAIN_PATTERN, {
        message: "timeGrain must match /^[a-z][a-z_]*$/",
      })
      .optional(),
    // The single dimension `timeGrain` applies to via `date_trunc`. A column
    // identifier (backtick-quoted at interpolation), so it accepts the full
    // delimited-identifier grammar. Cross-field rules in `superRefine`:
    // required when `timeGrain` is set, and must be one of `dimensions`.
    timeDimension: z
      .string()
      .min(1, { message: "timeDimension cannot be empty" })
      .refine(isValidColumnName, {
        message:
          "timeDimension contains a character that cannot be used in a SQL identifier (control character or newline)",
      })
      .optional(),
    orderBy: z
      .array(
        z
          .object({
            field: z
              .string()
              .min(1, "orderBy field cannot be empty")
              .refine(isValidColumnName, {
                message:
                  "orderBy field contains a character that cannot be used in a SQL identifier (control character or newline)",
              }),
            direction: z.enum(METRIC_ORDER_DIRECTIONS).optional(),
          })
          .strict(),
      )
      .min(1, "orderBy cannot be an empty array")
      .max(METRIC_ORDER_BY_MAX, {
        message: `orderBy length exceeds the maximum of ${METRIC_ORDER_BY_MAX}`,
      })
      .optional(),
    limit: z
      .number()
      .int({ message: "limit must be an integer" })
      .positive({ message: "limit must be positive" })
      .max(METRIC_LIMIT_MAX, {
        message: `limit exceeds the maximum of ${METRIC_LIMIT_MAX}`,
      })
      .optional(),
    format: z.enum(["JSON_ARRAY", "ARROW_STREAM", "JSON", "ARROW"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.filter != null) {
      validateFilterTree(value.filter, ctx, ["filter"], 0);
    }

    const seen = new Set<string>();
    const collided = new Set<string>();
    for (const name of [...value.measures, ...(value.dimensions ?? [])]) {
      if (seen.has(name)) {
        collided.add(name);
      }
      seen.add(name);
    }
    if (collided.size > 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "measures and dimensions must be unique across both lists (a name cannot repeat, nor appear as both a measure and a dimension)",
        path: ["measures"],
      });
    }

    if (
      value.format != null &&
      normalizeAnalyticsFormat(value.format) !== "JSON_ARRAY"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "format: only JSON_ARRAY is supported on the metric route at v1 (ARROW_STREAM is not yet implemented)",
        path: ["format"],
      });
    }

    if (value.timeGrain != null && value.timeDimension == null) {
      ctx.addIssue({
        code: "custom",
        message: "timeDimension is required when timeGrain is set",
        path: ["timeDimension"],
      });
    }
    if (
      value.timeDimension != null &&
      !(value.dimensions ?? []).includes(value.timeDimension)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "timeDimension must be one of dimensions",
        path: ["timeDimension"],
      });
    }

    if (value.orderBy != null) {
      const selectedNames = new Set([
        ...value.measures,
        ...(value.dimensions ?? []),
      ]);

      // Rule A: each orderBy[i].field must be in measures or dimensions
      for (let i = 0; i < value.orderBy.length; i++) {
        if (!selectedNames.has(value.orderBy[i].field)) {
          ctx.addIssue({
            code: "custom",
            message: "orderBy field must be one of measures or dimensions",
            path: ["orderBy", i, "field"],
          });
        }
      }

      // Rule B: no duplicate fields
      const seenFields = new Set<string>();
      let hasDuplicate = false;
      for (const entry of value.orderBy) {
        if (seenFields.has(entry.field)) {
          hasDuplicate = true;
          break;
        }
        seenFields.add(entry.field);
      }
      if (hasDuplicate) {
        ctx.addIssue({
          code: "custom",
          message: "orderBy fields must be unique",
          path: ["orderBy"],
        });
      }
    }
  }) as z.ZodType<IAnalyticsMetricRequest>;

function validateFilterTree(
  node: MetricFilter,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
): void {
  if (node === null || typeof node !== "object") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "filter node must be a Predicate or { and } / { or } group",
    });
    return;
  }

  if ("and" in node || "or" in node) {
    if (depth + 1 > METRIC_FILTER_MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}`,
      });
      return;
    }

    const groupKey = "and" in node ? "and" : "or";
    const children = (
      node as { and?: ReadonlyArray<MetricFilter> } & {
        or?: ReadonlyArray<MetricFilter>;
      }
    )[groupKey];

    if (!Array.isArray(children)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, groupKey],
        message: `filter ${groupKey} group must be an array of predicates or nested groups`,
      });
      return;
    }

    if (children.length === 0) {
      // Reject empty groups of either kind. An empty `or` is vacuously false;
      // an empty `and` contributes no constraint and renders to no WHERE
      // clause — identical SQL to omitting `filter` entirely, but it would
      // canonicalize to a distinct cache key (`and()` vs `_`), needlessly
      // splitting the cache across semantically identical requests. Requiring
      // at least one child keeps request shape ↔ cache key one-to-one.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, groupKey],
        message: `filter '${groupKey}' group must contain at least one predicate`,
      });
      return;
    }

    children.forEach((child, idx) => {
      validateFilterTree(child, ctx, [...path, groupKey, idx], depth + 1);
    });
    return;
  }

  const predicate = node as MetricPredicate;

  if (
    !METRIC_FILTER_OPERATORS.includes(
      predicate.operator as MetricFilterOperatorName,
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "operator"],
      message: `filter operator "${predicate.operator}" is not one of: ${METRIC_FILTER_OPERATORS.join(", ")}`,
    });
    return;
  }

  const op = predicate.operator;
  const values = predicate.values;
  const valuesLen = values?.length ?? 0;

  if (NULL_OPERATORS.has(op)) {
    if (values != null && valuesLen > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" must not carry values`,
      });
    }
  } else if (SINGLE_VALUE_OPERATORS.has(op)) {
    if (valuesLen !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires exactly one value (got ${valuesLen})`,
      });
    }
  } else if (LIST_VALUE_OPERATORS.has(op)) {
    if (valuesLen < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires at least one value`,
      });
    }
  }

  if (STRING_OPERATORS.has(op) && valuesLen > 0) {
    const v = predicate.values?.[0];
    if (typeof v !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires a string value (got ${typeof v})`,
      });
    }
  }
}

function preCheckFilterDepth(filter: unknown): void {
  if (filter == null || typeof filter !== "object") return;
  const stack: Array<[unknown, number]> = [[filter, 0]];
  while (stack.length > 0) {
    const popped = stack.pop();
    if (popped === undefined) continue;
    const [node, depth] = popped;
    if (node == null || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    for (const groupKey of ["and", "or"] as const) {
      const children = obj[groupKey];
      if (!Array.isArray(children)) continue;
      if (children.length > METRIC_FILTER_GROUP_MAX) {
        throw new ValidationError(
          "Invalid metric request body (fields: filter)",
          {
            context: {
              reason: `filter ${groupKey} group has ${children.length} children; the maximum is ${METRIC_FILTER_GROUP_MAX}`,
            },
          },
        );
      }
      if (depth + 1 > METRIC_FILTER_MAX_DEPTH) {
        throw new ValidationError(
          "Invalid metric request body (fields: filter)",
          {
            context: {
              reason: `filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}`,
            },
          },
        );
      }
      for (const child of children) {
        stack.push([child, depth + 1]);
      }
    }
  }
}

export function validateMetricRequest(body: unknown): IAnalyticsMetricRequest {
  if (body != null && typeof body === "object") {
    preCheckFilterDepth((body as { filter?: unknown }).filter);
  }
  const result = metricRequestSchema.safeParse(body);
  if (!result.success) {
    const fieldPaths = result.error.issues
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    throw new ValidationError(
      fieldPaths.length > 0
        ? `Invalid metric request body (fields: ${fieldPaths})`
        : "Invalid metric request body",
      { context: { issues: result.error.issues } },
    );
  }
  return result.data;
}

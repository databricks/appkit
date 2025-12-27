import type { Table } from "apache-arrow";

// ============================================================================
// Data Format Types
// ============================================================================

/** Supported response formats for analytics queries */
export type AnalyticsFormat = "JSON" | "ARROW";

/**
 * Typed Arrow Table - preserves row type information for type inference.
 * At runtime this is just a regular Arrow Table, but TypeScript knows the row schema.
 *
 * @example
 * ```typescript
 * type MyTable = TypedArrowTable<{ id: string; value: number }>;
 * // Can access table.getChild("id") knowing it exists
 * ```
 */
export interface TypedArrowTable<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> extends Table {
  /**
   * Phantom type marker for row schema.
   * Not used at runtime - only for TypeScript type inference.
   */
  readonly __rowType?: TRow;
}

// ============================================================================
// Query Options & Result Types
// ============================================================================

/** Options for configuring an analytics SSE query */
export interface UseAnalyticsQueryOptions<F extends AnalyticsFormat = "JSON"> {
  /** Response format - "JSON" returns typed arrays, "ARROW" returns TypedArrowTable */
  format?: F;

  /** Maximum size of serialized parameters in bytes */
  maxParametersSize?: number;

  /** Whether to automatically start the query when the hook is mounted. Default is true. */
  autoStart?: boolean;

  /** Whether to execute the query as a user. Default is false. */
  asUser?: boolean;
}

/** Result state returned by useAnalyticsQuery */
export interface UseAnalyticsQueryResult<T> {
  /** Latest query result data */
  data: T | null;
  /** Loading state of the query */
  loading: boolean;
  /** Error state of the query */
  error: string | null;
}

/**
 * Query Registry for type-safe analytics queries.
 * Extend this interface via module augmentation to get full type inference:
 *
 * @example
 * ```typescript
 * // config/appKitTypes.d.ts
 * declare module "@databricks/appkit-ui/react" {
 *   interface QueryRegistry {
 *     apps_list: {
 *       name: "apps_list";
 *       parameters: { startDate: string; endDate: string; aggregationLevel: string };
 *       result: Array<{ id: string; name: string }>;
 *     };
 *   }
 * }
 * ```
 */
export interface QueryRegistry {
  [key: string]: {
    name: string;
    parameters: Record<string, unknown>;
    result: unknown[];
  };
}

/** Gets only literal keys from a registry (excludes index signature) */
export type AugmentedRegistry<T> = keyof {
  [K in keyof T as string extends K ? never : K]: T[K];
};

/** Resolves to registry keys if defined, otherwise string */
export type QueryKey = AugmentedRegistry<QueryRegistry> extends never
  ? string
  : AugmentedRegistry<QueryRegistry>;

/**
 * Infers result type from QueryRegistry[K]["result"]
 * Returns the JSON array type for the query.
 */
export type InferResult<T, K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K] extends { result: infer R }
    ? R
    : T
  : T;

/**
 * Infers the row type from a query result array.
 * Used for TypedArrowTable row typing.
 */
export type InferRowType<K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K] extends { result: Array<infer R> }
    ? R extends Record<string, unknown>
      ? R
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;

/**
 * Conditionally infers result type based on format.
 * - JSON format: Returns the typed array from QueryRegistry
 * - ARROW format: Returns TypedArrowTable with row type preserved
 */
export type InferResultByFormat<
  T,
  K,
  F extends AnalyticsFormat,
> = F extends "ARROW" ? TypedArrowTable<InferRowType<K>> : InferResult<T, K>;

/**
 * Infers parameters type from QueryRegistry[K]["parameters"]
 */
export type InferParams<K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K] extends { parameters: infer P }
    ? P
    : Record<string, unknown>
  : Record<string, unknown>;

export interface PluginRegistry {
  [key: string]: Record<string, any>;
}

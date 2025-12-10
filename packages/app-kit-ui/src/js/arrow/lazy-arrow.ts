/**
 * Lazy loader for Apache Arrow library.
 * The arrow library is substantial (~200KB+ gzipped), so we only load it
 * when Arrow format is actually used.
 *
 * This module caches the import promise to ensure the library is only
 * loaded once, even if multiple components request it simultaneously.
 */

import type { Table, Field } from "apache-arrow";

// Re-export types for convenience (types don't add to bundle size)
export type { Table, Field };

// ============================================================================
// Lazy Module Loading
// ============================================================================

// Cache the import promise to avoid multiple loads
let arrowModulePromise: Promise<typeof import("apache-arrow")> | null = null;

/**
 * Lazily loads the Apache Arrow library.
 * Returns cached module if already loaded.
 *
 * @example
 * ```typescript
 * const arrow = await getArrowModule();
 * const table = arrow.tableFromIPC(buffer);
 * ```
 */
export async function getArrowModule(): Promise<typeof import("apache-arrow")> {
  if (!arrowModulePromise) {
    arrowModulePromise = import("apache-arrow");
  }
  return arrowModulePromise;
}

// ============================================================================
// Cached Type ID Sets
// ============================================================================

// These are initialized lazily when Arrow is first loaded
let temporalTypeIds: Set<number> | null = null;
let numericTypeIds: Set<number> | null = null;
let stringTypeIds: Set<number> | null = null;
let decimalTypeId: number | null = null;

/**
 * Initializes the type ID sets from the Arrow Type enum.
 * Call this after loading the Arrow module.
 */
export async function initializeTypeIdSets(): Promise<void> {
  if (temporalTypeIds !== null) return; // Already initialized

  const { Type } = await getArrowModule();

  temporalTypeIds = new Set([
    Type.Date,
    Type.DateDay,
    Type.DateMillisecond,
    Type.Timestamp,
    Type.TimestampSecond,
    Type.TimestampMillisecond,
    Type.TimestampMicrosecond,
    Type.TimestampNanosecond,
    Type.Time,
    Type.TimeSecond,
    Type.TimeMillisecond,
    Type.TimeMicrosecond,
    Type.TimeNanosecond,
  ]);

  numericTypeIds = new Set([
    Type.Int,
    Type.Int8,
    Type.Int16,
    Type.Int32,
    Type.Int64,
    Type.Uint8,
    Type.Uint16,
    Type.Uint32,
    Type.Uint64,
    Type.Float,
    Type.Float16,
    Type.Float32,
    Type.Float64,
    Type.Decimal,
  ]);

  stringTypeIds = new Set([Type.Utf8, Type.LargeUtf8]);

  decimalTypeId = Type.Decimal;
}

/**
 * Returns the cached type ID sets.
 * Throws if called before initializeTypeIdSets().
 * This is safe because you can't have a Table without first loading Arrow.
 */
export function getTypeIdSets(): {
  temporal: Set<number>;
  numeric: Set<number>;
  string: Set<number>;
} {
  if (!temporalTypeIds || !numericTypeIds || !stringTypeIds) {
    throw new Error(
      "Arrow type IDs not initialized. Call initializeTypeIdSets() first.",
    );
  }
  return {
    temporal: temporalTypeIds,
    numeric: numericTypeIds,
    string: stringTypeIds,
  };
}

/**
 * Returns the Decimal type ID.
 * Throws if called before initializeTypeIdSets().
 */
export function getDecimalTypeId(): number {
  if (decimalTypeId === null) {
    throw new Error(
      "Arrow type IDs not initialized. Call initializeTypeIdSets() first.",
    );
  }
  return decimalTypeId;
}

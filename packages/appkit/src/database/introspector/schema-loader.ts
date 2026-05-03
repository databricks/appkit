import type { Schema } from "../index";

/**
 * Maximum number of `default` / `schema` wrappers to peel off the imported
 * module before giving up.
 *
 * TS loaders (tsx, ts-node, esbuild-register, vite-node) sometimes wrap the
 * user's `export default schema` an extra time. The most common shapes are:
 *
 *   - `mod.default = schema`           (esm with single default)
 *   - `mod.default.default = schema`   (cjs interop wrapper around esm)
 *   - `mod.default.default.default = schema`  (interop in interop, rare)
 *
 * Three iterations covers all observed shapes without iterating forever on a
 * pathological self-referential object.
 */
const MAX_UNWRAP_DEPTH = 3;

/**
 * Type-guard for AppKit schemas.
 *
 * `defineSchema(...)` returns an object with a `$tables` map and a `$drizzle`
 * registry. Anything else is rejected with a configuration error by the
 * convention loader so missing exports surface a clear message instead of a
 * cryptic property access later.
 */
export function isSchema(value: unknown): value is Schema {
  return (
    typeof value === "object" &&
    value !== null &&
    "$drizzle" in value &&
    "$tables" in value &&
    typeof (value as { $tables?: unknown }).$tables === "object"
  );
}

/**
 * Walk the imported module looking for an AppKit schema.
 *
 * Returns the schema when found, `undefined` otherwise. The shared CLI loader
 * (`packages/shared/src/cli/commands/db/shared.ts`) and the runtime convention
 * loader (`packages/appkit/src/plugins/database/convention.ts`) both call this
 * so a change in module-loader interop only needs to be fixed in one place.
 */
export function extractSchema(mod: unknown): Schema | undefined {
  let current = mod;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    if (isSchema(current)) return current;
    if (typeof current !== "object" || current === null) return undefined;

    const exports = current as { default?: unknown; schema?: unknown };
    current = exports.schema ?? exports.default;
  }
  return isSchema(current) ? current : undefined;
}

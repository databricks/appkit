/**
 * Plugin-name casing helpers. A dependency-free leaf module so both the
 * runtime (appkit) and the bundled CLI can import it without pulling in the
 * heavier `plugin.ts` graph.
 */

/** Type-level kebab-to-camelCase (e.g. `"ai-search"` -> `"aiSearch"`). */
export type KebabToCamel<S extends string> =
  S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
    : S;

/** Runtime {@link KebabToCamel}. */
export function kebabToCamel(name: string): string {
  return name.replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * camelCase to kebab-case (e.g. `"aiSearch"` -> `"ai-search"`). Used to derive
 * HTTP route prefixes and folder paths from the canonical camelCase plugin
 * name. A no-op for single-word names.
 */
export function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

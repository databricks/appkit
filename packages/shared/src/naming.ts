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

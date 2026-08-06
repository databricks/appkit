/**
 * Plugin-name casing helpers. A dependency-free leaf module so both the
 * runtime (appkit) and the bundled CLI can import it without pulling in the
 * heavier `plugin.ts` graph.
 */

/**
 * Canonical plugin-name charset: a lowercase-initial camelCase JS identifier
 * (e.g. `aiSearch`). The name doubles as the JS binding and the accessor key,
 * so kebab is not allowed. Single source of truth for the manifest schema and
 * the plugin-tree generators.
 */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/** kebab-case to camelCase (e.g. `"ai-search"` -> `"aiSearch"`). */
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

import type { ToolkitOptions } from "./types";

/**
 * Filter / prefix / rename a tool's local name into its toolkit key, or
 * skip it entirely. Encapsulates the four-knob `ToolkitOptions` contract:
 *
 * - `only` — allowlist of local names; everything else is dropped.
 * - `except` — denylist of local names.
 * - `prefix` — string prepended to the local name; defaults to
 *   `${pluginName}.`. Pass `""` to drop the prefix entirely.
 * - `rename` — per-tool exact remapping; wins over `prefix`.
 *
 * Returns the final key, or `null` when the tool is filtered out.
 *
 * Single source of truth so {@link buildToolkitEntries} (registry path)
 * and {@link resolveToolkitFromProvider} (`getAgentTools()` fallback) stay
 * in lockstep — bug fixes here apply to both.
 */
export function applyToolkitOptions(
  localName: string,
  pluginName: string,
  opts: ToolkitOptions = {},
): string | null {
  // `only`/`except` take precedence: filter first, then derive the key.
  if (opts.only && !opts.only.includes(localName)) return null;
  if (opts.except?.includes(localName)) return null;

  // `rename` accepts string overrides; explicit `undefined` (e.g. from a
  // ternary that didn't fire) and empty strings fall through to the prefix
  // path so we never produce a tool keyed literally `"undefined"` or `""`.
  const renamed = opts.rename?.[localName];
  if (typeof renamed === "string" && renamed.length > 0) return renamed;

  const prefix = opts.prefix ?? `${pluginName}.`;
  return `${prefix}${localName}`;
}

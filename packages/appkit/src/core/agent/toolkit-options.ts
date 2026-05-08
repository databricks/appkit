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
  if (opts.only && !opts.only.includes(localName)) return null;
  if (opts.except?.includes(localName)) return null;

  const rename = opts.rename ?? {};
  if (Object.hasOwn(rename, localName)) return rename[localName];

  const prefix = opts.prefix ?? `${pluginName}.`;
  return `${prefix}${localName}`;
}

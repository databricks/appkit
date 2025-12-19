import type { Plugin } from "vite";

export function mergeConfigDedup(
  base: any,
  override: any,
  mergeFn: (a: any, b: any) => any,
) {
  const merged = mergeFn(base, override);
  if (base.plugins && override.plugins) {
    const seen = new Set<string>();
    merged.plugins = [...base.plugins, ...override.plugins].filter(
      (p: Plugin) => {
        const name = p.name;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      },
    );
  }
  return merged;
}

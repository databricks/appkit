import type { Plugin } from "vite";

function flattenPlugins(plugins: any[]): Plugin[] {
  return plugins.flat(Infinity).filter(Boolean);
}

export function mergeConfigDedup(
  base: any,
  override: any,
  mergeFn: (a: any, b: any) => any,
) {
  const merged = mergeFn(base, override);
  if (base.plugins && override.plugins) {
    const seen = new Set<string>();
    const allPlugins = flattenPlugins([...base.plugins, ...override.plugins]);
    merged.plugins = allPlugins.filter((p) => {
      const name = p.name;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }
  return merged;
}

---
title: "fix: mergeConfigDedup crashes on array-returning Vite plugins"
type: fix
date: 2026-02-06
---

# fix: mergeConfigDedup crashes on array-returning Vite plugins

## Overview

`mergeConfigDedup` in `packages/appkit/src/utils/vite-config-merge.ts` assumes every entry in the `plugins` array is a single `Plugin` object with a `.name` property. However, Vite's `PluginOption` type allows plugins to be arrays (nested), falsy values (`false | null | undefined`), or promises. Plugins like `@tailwindcss/vite` return `Plugin[]` — a standard Vite convention called "plugin presets." This causes `mergeConfigDedup` to fail because it accesses `.name` on an array.

## Problem Statement

```typescript
// Current code (vite-config-merge.ts:11-17)
merged.plugins = [...base.plugins, ...override.plugins].filter(
  (p: Plugin) => {        // <-- assumes p is always a Plugin object
    const name = p.name;  // <-- crashes/undefined when p is an array
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  },
);
```

**When a user's Vite config includes:**
```typescript
// user's vite.config.ts
import tailwindcss from "@tailwindcss/vite";
export default { plugins: [tailwindcss()] }  // tailwindcss() returns Plugin[]
```

The spread `...base.plugins` produces `[Plugin[]]` (an array containing an array), and accessing `.name` on the inner array returns `undefined`, breaking deduplication.

**Vite's own `PluginOption` type for reference:**
```typescript
type PluginOption = Thenable<Plugin | FalsyPlugin | PluginOption[]>
type FalsyPlugin = false | null | undefined
```

## Proposed Solution

Flatten and filter the plugins array before deduplicating, matching Vite's own behavior:

1. **Flatten** nested arrays recursively (handles `@tailwindcss/vite` and similar)
2. **Filter out falsy values** (`false`, `null`, `undefined`) — standard Vite convention for conditional plugins
3. **Then deduplicate** by `.name` as before

### Implementation

**File:** `packages/appkit/src/utils/vite-config-merge.ts`

```typescript
import type { Plugin } from "vite";

function flattenPlugins(plugins: any[]): Plugin[] {
  return plugins.flat(Infinity).filter(Boolean) as Plugin[];
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
```

### Key decisions

- **`flat(Infinity)`** handles arbitrarily nested arrays (Vite's `PluginOption[]` is recursive)
- **`filter(Boolean)`** removes `false | null | undefined` entries (Vite convention for conditional plugins like `condition && plugin()`)
- Helper is a local function, not exported — only needed here

## Acceptance Criteria

- [x] `mergeConfigDedup` handles plugins that return arrays (e.g. `@tailwindcss/vite`)
- [x] Falsy plugin entries (`false`, `null`, `undefined`) are filtered out without errors
- [x] Deeply nested plugin arrays are flattened correctly
- [x] Deduplication by `.name` still works as before for single Plugin objects
- [x] Unit tests cover: single plugins, array plugins, mixed, falsy values, nested arrays, dedup across both

## Test Plan

**New test file:** `packages/appkit/src/utils/tests/vite-config-merge.test.ts`

```typescript
describe("mergeConfigDedup", () => {
  // existing behavior
  it("deduplicates plugins by name across base and override")
  it("preserves base plugin when duplicate exists in override")
  it("returns merged config when no plugins on either side")

  // new: array plugin support
  it("flattens array-returning plugins (e.g. @tailwindcss/vite)")
  it("deduplicates across flattened array plugins and single plugins")
  it("handles deeply nested plugin arrays")

  // new: falsy plugin filtering
  it("filters out false/null/undefined plugin entries")
  it("handles mixed falsy and valid plugins")
});
```

## References

- **Bug location:** `packages/appkit/src/utils/vite-config-merge.ts:11-17`
- **Call site:** `packages/appkit/src/plugins/server/vite-dev-server.ts:75`
- **Vite PluginOption type:** [vite/src/node/plugin.ts](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/plugin.ts)
- **@tailwindcss/vite source:** [tailwindcss/@tailwindcss-vite/src/index.ts](https://github.com/tailwindlabs/tailwindcss/blob/main/packages/@tailwindcss-vite/src/index.ts) — returns 3 plugins in an array
- **Vite plugin preset convention:** [vite.dev/guide/api-plugin](https://vite.dev/guide/api-plugin)

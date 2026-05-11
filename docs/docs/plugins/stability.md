---
sidebar_position: 2
---

# Plugin Stability Tiers

AppKit plugins have a two-tier stability system that communicates API maturity and breaking-change expectations.

## Tiers

| Tier | Import Path | Contract |
|------|------------|---------|
| **Beta** | `@databricks/appkit/beta` | API may change between minor releases. On a path to GA. |
| **GA** | `@databricks/appkit` | Generally available. Production ready. Follows semver strictly. |

The import path is the primary stability signal. Importing from `/beta` is explicit consent to potential breaking changes.

## Promotion Path

Promotion is one-way. Plugins can enter at any tier.

```
beta ──→ ga
```

## Usage

### Importing Plugins by Tier

```typescript
// GA plugins
import { server, analytics } from "@databricks/appkit";

// Beta plugins
import { someBetaPlugin } from "@databricks/appkit/beta";
```

### UI Components

`@databricks/appkit-ui` mirrors the same pattern:

```typescript
import { SomeComponent } from "@databricks/appkit-ui/react/beta";
import { someUtil } from "@databricks/appkit-ui/js/beta";
```

## CLI Commands

### Listing Plugins with Stability

```bash
npx appkit plugin list
```

The output includes a STABILITY column showing each plugin's tier.

### Creating a Plugin with Stability

```bash
npx appkit plugin create
```

The interactive flow prompts for a stability level (defaults to GA).

### Promoting a Plugin

```bash
# Promote from beta to GA
npx appkit plugin promote my-plugin --to ga

# Preview changes without modifying files
npx appkit plugin promote my-plugin --to ga --dry-run
```

The promote command:
- Updates the plugin's `manifest.json` stability field
- Rewrites import paths across your project's `.ts`/`.tsx` files
- Runs `plugin sync` to update `appkit.plugins.json`

**Options:**
- `--dry-run` -- Show what would change without writing
- `--skip-imports` -- Only update the manifest
- `--skip-sync` -- Don't auto-run sync
- `--allow-installed` -- Allow promoting a plugin that lives only under `node_modules` (advanced)

## Manifest Field

The `stability` field in `manifest.json` is optional. When absent, the plugin is considered GA.

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "description": "An in-development feature",
  "stability": "beta",
  "resources": { "required": [], "optional": [] }
}
```

Valid values: `"beta"`, `"ga"`.

## Template Manifest (appkit.plugins.json)

When `plugin sync` discovers non-GA plugins, it includes their stability in the output. That is true for **every** discovery path: plugins resolved from your server file, from `--plugins-dir` / local plugin trees, and from known packages under `node_modules` (for example `@databricks/appkit`). The tier in each plugin’s `manifest.json` is always reflected in the synced template manifest when it is not GA.

```json
{
  "version": "1.1",
  "plugins": {
    "my-plugin": {
      "name": "my-plugin",
      "stability": "beta",
      "package": "@databricks/appkit"
    }
  }
}
```

Only GA plugins can be marked `requiredByTemplate`. Non-GA plugins always remain optional during init.

## For Third-Party Plugin Authors

The import path (`/beta`) only applies to first-party plugins shipped inside `@databricks/appkit`. Third-party plugins declare stability via the `stability` field in their `manifest.json`. CLI tooling (`plugin list`, `plugin sync`) surfaces this information to users.

## For First-Party Plugin Authors (AppKit Monorepo)

Inside the AppKit monorepo, each plugin's `manifest.json` `stability` field is the **single source of truth** for which subpath ships the plugin. Two build-time generators read every `packages/appkit/src/plugins/<name>/manifest.json`:

- `tools/generate-plugin-entries.ts` writes the runtime export barrels:
  - `packages/appkit/src/plugins/ga-exports.generated.ts` — re-exports of GA plugins, included by `src/index.ts` (the `@databricks/appkit` entry).
  - `packages/appkit/src/plugins/beta-exports.generated.ts` — re-exports of beta plugins, included by `src/beta.ts` (the `@databricks/appkit/beta` entry).
- `tools/generate-plugin-doc-banners.ts` injects (or removes) a `:::warning Beta plugin` admonition at the top of each plugin's docs page (`docs/docs/plugins/<name>.md`) so a plugin's documented stability follows its manifest. The script only writes under `docs/docs/plugins/`: each manifest `name` must match the plugin schema pattern (`^[a-z][a-z0-9-]*$`), and resolved doc paths are checked so a malformed `name` cannot escape that directory.

All generated artifacts are committed and verified by CI; an out-of-date file fails the `Check generated types are up to date` step.

The `appkit plugin promote` command detects monorepo context (presence of `tools/generate-plugin-entries.ts`) and re-runs the generator after updating the manifest, so the runtime exports, the synced `appkit.plugins.json`, and the manifest can never drift apart.

To move a built-in plugin between tiers manually:

```bash
# Edit packages/appkit/src/plugins/<name>/manifest.json
# Set "stability": "beta" (or remove the field for GA)
pnpm run generate:types   # regenerates schema/registry types, export barrels, and doc banners
pnpm sync:template        # regenerates template/appkit.plugins.json
```

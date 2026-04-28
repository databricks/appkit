---
sidebar_position: 2
---

# Plugin Stability Tiers

AppKit plugins have a three-tier stability system that communicates API maturity and breaking-change expectations.

## Tiers

| Tier | Import Path | Contract |
|------|------------|---------|
| **Experimental** | `@databricks/appkit/experimental` | Very unstable. May be dropped entirely. No guarantee of promotion. |
| **Preview** | `@databricks/appkit/preview` | API may change between minor releases. On a path to stable. |
| **Stable** | `@databricks/appkit` | Production ready. Follows semver strictly. |

The import path is the primary stability signal. Importing from `/experimental` or `/preview` is explicit consent to potential breaking changes.

## Promotion Path

Promotion is one-way. Plugins can enter at any tier.

```
experimental ──→ preview ──→ stable
      │
      └──→ (dropped)
```

## Usage

### Importing Plugins by Tier

```typescript
// Stable plugins
import { server, analytics } from "@databricks/appkit";

// Preview plugins
import { somePreviewPlugin } from "@databricks/appkit/preview";

// Experimental plugins
import { someExperimentalPlugin } from "@databricks/appkit/experimental";
```

### UI Components

`@databricks/appkit-ui` mirrors the same pattern:

```typescript
import { SomeComponent } from "@databricks/appkit-ui/react/preview";
import { someUtil } from "@databricks/appkit-ui/js/experimental";
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

The interactive flow prompts for a stability level (defaults to stable).

### Promoting a Plugin

```bash
# Promote from experimental to preview
npx appkit plugin promote my-plugin --to preview

# Promote from preview to stable
npx appkit plugin promote my-plugin --to stable

# Preview changes without modifying files
npx appkit plugin promote my-plugin --to preview --dry-run
```

The promote command:
- Updates the plugin's `manifest.json` stability field
- Rewrites import paths across your project's `.ts`/`.tsx` files
- Runs `plugin sync` to update `appkit.plugins.json`

**Options:**
- `--dry-run` -- Show what would change without writing
- `--skip-imports` -- Only update the manifest
- `--skip-sync` -- Don't auto-run sync

## Manifest Field

The `stability` field in `manifest.json` is optional. When absent, the plugin is considered stable.

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "description": "An experimental feature",
  "stability": "experimental",
  "resources": { "required": [], "optional": [] }
}
```

Valid values: `"experimental"`, `"preview"`, `"stable"`.

## Template Manifest (appkit.plugins.json)

When `plugin sync` discovers non-stable plugins, it includes their stability in the output:

```json
{
  "version": "1.1",
  "plugins": {
    "my-plugin": {
      "name": "my-plugin",
      "stability": "experimental",
      "package": "@databricks/appkit"
    }
  }
}
```

Only stable plugins can be marked `requiredByTemplate`. Non-stable plugins always remain optional during init.

## For Third-Party Plugin Authors

The import paths (`/experimental`, `/preview`) only apply to first-party plugins shipped inside `@databricks/appkit`. Third-party plugins declare stability via the `stability` field in their `manifest.json`. CLI tooling (`plugin list`, `plugin sync`) surfaces this information to users.

## Current Plugins by Tier

All built-in plugins are currently **stable**:

- `server` -- Express HTTP server
- `analytics` -- SQL query execution
- `files` -- Multi-volume file browser
- `genie` -- Genie Space integration
- `lakebase` -- Postgres Autoscaling

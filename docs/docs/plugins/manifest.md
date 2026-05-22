---
sidebar_position: 8
---

# Plugin manifest

Every plugin ships a `manifest.json` next to its source code. The manifest declares plugin metadata, the Databricks resources the plugin needs, and any structured rules a scaffolding agent must honor when running `databricks apps init`. It is consumed at three stages:

- **Authoring** — `import manifest from "./manifest.json"` and attach it to the `Plugin` subclass via `static manifest`.
- **Sync** — `appkit plugin sync --write` aggregates manifests from installed packages and local plugins into `appkit.plugins.json`.
- **Init** — `databricks apps init` reads `appkit.plugins.json` to drive plugin selection, resource prompts, and `.env` / `databricks.yml` / `app.yaml` generation.

This page documents the **v2.0** manifest contract. JSON Schema is published at `https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json`; reference it via `$schema` for editor validation.

## Recommended pattern

Author the manifest as JSON, import it into the plugin module, and assert the type:

```typescript
// packages/my-plugin/src/index.ts
import { Plugin, toPlugin } from "@databricks/appkit";
import type { PluginManifest } from "@databricks/appkit";
import manifest from "./manifest.json";

class MyPlugin extends Plugin {
  static manifest = manifest as PluginManifest<"my-plugin">;
  // ...
}

export const myPlugin = toPlugin(MyPlugin);
```

```json
// packages/my-plugin/src/manifest.json
{
  "$schema": "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
  "name": "my-plugin",
  "displayName": "My Plugin",
  "description": "A custom plugin",
  "resources": {
    "required": [],
    "optional": []
  }
}
```

JSON is the canonical authoring surface — it is what `appkit plugin sync` reads. JS manifests (`manifest.js` / `manifest.cjs`) are ignored by default and require `--allow-js-manifest` to opt in (executes plugin code; trust required). For end-to-end CLI behavior, see [Plugin management](./plugin-management.md).

## Required fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Plugin identifier. Lowercase, starts with a letter, `[a-z0-9-]` only. |
| `displayName` | `string` | Shown in UI and CLI prompts. |
| `description` | `string` | Brief summary. |
| `resources.required` | `ResourceRequirement[]` | Resources the plugin cannot run without. |
| `resources.optional` | `ResourceRequirement[]` | Resources that enhance behavior but are not mandatory. |

## Resources

A resource requirement declares one Databricks resource the plugin depends on. The shape is keyed by `type`; each type fixes its valid `permission` values (validated by the schema as a discriminated union):

| `type` | Permissions |
|--------|-------------|
| `secret` | `READ`, `WRITE`, `MANAGE` |
| `job` | `CAN_VIEW`, `CAN_MANAGE_RUN`, `CAN_MANAGE` |
| `sql_warehouse` | `CAN_USE`, `CAN_MANAGE` |
| `serving_endpoint` | `CAN_VIEW`, `CAN_QUERY`, `CAN_MANAGE` |
| `volume` | `READ_VOLUME`, `WRITE_VOLUME` |
| `vector_search_index` | `SELECT` |
| `uc_function` | `EXECUTE` |
| `uc_connection` | `USE_CONNECTION` |
| `database` | `CAN_CONNECT_AND_CREATE` |
| `postgres` | `CAN_CONNECT_AND_CREATE` |
| `genie_space` | `CAN_VIEW`, `CAN_RUN`, `CAN_EDIT`, `CAN_MANAGE` |
| `experiment` | `CAN_READ`, `CAN_EDIT`, `CAN_MANAGE` |
| `app` | `CAN_USE` |

Every requirement has:

- `alias` — human-readable label used in UI / CLI output.
- `resourceKey` — stable machine key (`[a-z][a-z0-9-]*`). Used for deduplication, env naming, and references in `app.yaml`. **Identity is keyed on `resourceKey`, not `alias`.**
- `description` — explains *why* this resource is needed; surfaces in interactive prompts.
- `fields` — map of field name → field entry (see below). At least one entry when present.
- `permission` — must match the type's allowed enum.

Single-value resource types (e.g. `sql_warehouse`) typically declare one field (`id`). Multi-value types (e.g. `secret`, `database`) declare several (`scope` + `key`, `instance_name` + `database_name`).

### Field entry

```json
{
  "id": {
    "env": "DATABRICKS_WAREHOUSE_ID",
    "description": "SQL Warehouse ID",
    "examples": ["1234abcd5678efgh"],
    "discovery": { "type": "kind", "resourceKind": "warehouse" }
  }
}
```

| Property | Description |
|----------|-------------|
| `env` | Environment variable name written to `.env` and `app.yaml`. Must match `^[A-Z][A-Z0-9_]*$`. |
| `description` | Shown in interactive prompts and bundle variable descriptions. |
| `examples` | Sample values shown in field descriptions. |
| `localOnly` | When `true`, the field is generated for local `.env` only — the Databricks Apps platform auto-injects it at deploy time, so it is excluded from `app.yaml` and `databricks.yml`. |
| `bundleIgnore` | Excluded from `databricks.yml` variables (still written to `.env`). |
| `value` | Static default value. |
| `resolve` | CLI-side resolver name, formatted `<resource_type>:<field>` (e.g. `postgres:host`). The CLI populates the value from API calls during init. |
| `discovery` | Describes how the CLI lists candidate values — see below. |

### Configuration-dependent resources

The manifest distinguishes `required` from `optional` for static analysis. When a resource only becomes required based on the plugin's runtime config, list it under `optional` in the manifest and override at runtime via a static `getResourceRequirements(config)` method on the plugin class. See [Creating custom plugins](./custom-plugins.md#config-dependent-resources).

## Resource discovery

Discovery describes how the CLI offers candidate values for a field during interactive init. There are two variants under `discovery`, discriminated by `type`:

### `kind` variant (preferred)

```json
{
  "discovery": {
    "type": "kind",
    "resourceKind": "warehouse"
  }
}
```

The `kind` variant references a well-known Databricks resource kind for which AppKit owns the listing command and response shape. This is the preferred form for first-party Databricks resources — plugin authors declare *what* to list, and AppKit owns *how* to list it.

Supported `resourceKind` values:

| `resourceKind` | Listed via |
|----------------|------------|
| `warehouse` | `databricks warehouses list` |
| `genie_space` | `databricks genie list-spaces` |
| `volume` | `databricks volumes list {catalog} {schema}` |
| `postgres_project` | `databricks postgres list-projects` |
| `postgres_branch` | `databricks postgres list-branches {project}` |
| `postgres_database` | `databricks postgres list-databases {branch}` |

Supported options on the `kind` variant:

| Property | Description |
|----------|-------------|
| `select` | Field name in the parsed CLI response used as the selected value (e.g. `"id"`, `"name"`, `"full_name"`). Defaults to the kind's natural identifier. |
| `display` | Field name shown to the user during selection. Defaults to `select`. |
| `dependsOn` | Name of a sibling field within the same resource that must resolve first (see [Field dependencies](#field-dependencies)). |
| `shortcut` | Single-value fast-path command that returns exactly one value, skipping interactive selection. |

### `cli` variant (escape hatch)

For resources outside the `kind` map, fall back to the `cli` variant:

```json
{
  "discovery": {
    "type": "cli",
    "cliCommand": "databricks custom-resource list --profile <PROFILE> --output json",
    "selectField": ".id",
    "displayField": ".name"
  }
}
```

| Property | Description |
|----------|-------------|
| `cliCommand` | Full Databricks CLI command. **Must include the literal `<PROFILE>` placeholder** — the runner substitutes the user's CLI profile. Shell metacharacters (`;`, `\|`, `&`, `` ` ``, `$`, newlines) are rejected — executors pass arguments via argv, never `shell-exec` the string. |
| `selectField` | jq-style path to the field used as the selected value (e.g. `.id`, `.name`). |
| `displayField` | jq-style path to the field shown to the user. Defaults to `selectField`. |
| `dependsOn` | Sibling field that must resolve first. |
| `shortcut` | Single-value fast-path command. Same metacharacter restriction as `cliCommand`. |

The `cli` variant is intentionally minimal and may tighten in future versions. **Prefer the `kind` variant** for any resource AppKit knows about; it gives you a single source of truth for command + unwrap rules and guarantees forward-compat as AppKit refines the discovery contract.

### Field dependencies

When listing one resource depends on another (e.g. listing volumes requires a catalog and schema; listing Postgres branches requires a project), use `dependsOn` to declare ordering:

```json
{
  "fields": {
    "project": {
      "discovery": { "type": "kind", "resourceKind": "postgres_project", "select": "name" }
    },
    "branch": {
      "discovery": {
        "type": "kind",
        "resourceKind": "postgres_branch",
        "select": "name",
        "dependsOn": "project"
      }
    }
  }
}
```

`dependsOn` references a sibling field name within the same resource. The CLI prompts in dependency order and substitutes the resolved value into the parent command (e.g. `{project}` in `databricks postgres list-branches {project}`).

The schema validates the dependency graph at parse time:

- Dangling references (`dependsOn` pointing at a non-existent sibling) are rejected.
- Cycles are rejected with the chain listed (`a → b → a`).

### Transient prompts (`parents`)

Some `kind`-variant commands need values that are **not** sibling fields on the resource — they are query inputs the runner collects once and discards. AppKit declares these on the `kind` itself via a `parents` array on `RESOURCE_KIND_COMMANDS`.

The only kind that uses `parents` today is `volume`:

```
volume → parents: ["catalog", "schema"]
```

Before invoking `databricks volumes list {catalog} {schema} --profile <PROFILE> --output json`, the runner prompts the user for each `parents` entry as free text and substitutes the value into the matching `{name}` placeholder. Unlike `dependsOn`, the collected values are **not** persisted as resource fields — they exist only for the duration of the listing call.

Plugin authors do not declare `parents` in their manifest; it is part of the AppKit-owned `kind` contract and surfaces in the published JSON Schema alongside each kind's command template.

## Scaffolding rules

`scaffolding.rules` is the plugin-level handoff to scaffolding agents (LLM-driven runners, custom CLI workflows, the `databricks-apps` skill). It carries up to three short directive lists — `must`, `should`, `never` — that the agent honors when invoking `databricks apps init` with this plugin selected.

```json
{
  "scaffolding": {
    "rules": {
      "should": [
        "After init, run any database migrations for your chosen ORM before first request",
        "After init, verify Lakebase connectivity with 'psql $PGHOST -c \"select 1\"'"
      ]
    }
  }
}
```

| Bucket | Semantics |
|--------|-----------|
| `must` | The agent must perform the action. |
| `should` | Recommended action — agent applies unless overridden. |
| `never` | The agent must not perform the action. |

### Authoring contract

- Each entry is a single short directive, **capped at 120 characters** by the schema. Long prose fails validation; split it into discrete actionable items.
- The schema enforces both **per-bucket dedup** (no two entries with the same text inside one of `must` / `should` / `never`) and **cross-bucket dedup** (one entry cannot belong to two buckets at once).
- Use the `Before init` / `After init` prefix convention when ordering matters so consumers can sequence directives consistently.

### Substitutability gate

A rule belongs in the manifest **only if it cannot be expressed as structured data** somewhere else — a resource permission, a `discovery` descriptor, a `dependsOn` chain, a `requiredByTemplate` flag, a config field, or the field's `env` / `value` / `resolve` slot.

Examples of what **does** survive the gate:

- `"After init, run any database migrations for your chosen ORM before first request"` — runtime sequencing, not derivable from any resource shape.
- `"After init, configure the 'spaces' map in plugin config with alias-to-Space-ID mappings"` — config-population guidance the schema cannot encode.

Examples of what does **not** survive (and should be modeled instead):

- "Plugin X requires `READ_VOLUME` on its volume" → already encoded in the resource's `permission` field.
- "The runner must list Postgres branches after a project is chosen" → already encoded via `dependsOn`.
- "Prompt the user for catalog and schema before listing volumes" → already encoded via `RESOURCE_KIND_COMMANDS.volume.parents`.

If you find yourself writing prose that the schema could capture, extend the schema instead.

The rules block is propagated unchanged from the plugin manifest into the synced template manifest. See [Templates — `scaffolding.rules` propagation](../development/templates.md#scaffoldingrules-propagation) for how the CLI merges plugin-level rules with the template-level rules block.

## Optional fields

| Field | Description |
|-------|-------------|
| `author` | Author name or organization. |
| `version` | Plugin version, semver format (`X.Y.Z` or `X.Y.Z-prerelease`). |
| `repository` | URL to the plugin source. |
| `keywords` | Discovery keywords. |
| `license` | SPDX identifier. |
| `onSetupMessage` | One-shot message displayed after init. Use for short hints; prefer `scaffolding.rules` for actionable directives an agent must enforce. |
| `hidden` | When `true`, the plugin is excluded from the synced template manifest. |
| `stability` | `"beta"` or `"ga"`. Beta plugins may break across minor releases — see [Plugin stability tiers](./stability.md). |
| `config.schema` | JSON Schema for the plugin's runtime config (used by the type generator and for validation). |

## See also

- [Creating custom plugins](./custom-plugins.md) — building a plugin from scratch.
- [Plugin management](./plugin-management.md) — `appkit plugin sync`, `create`, `validate`, `add-resource`.
- [Templates](../development/templates.md) — how the synced template manifest drives `databricks apps init`.
- [`PluginManifest` API reference](../api/appkit/Interface.PluginManifest.md) — TypeScript type.

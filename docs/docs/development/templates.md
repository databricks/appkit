---
sidebar_position: 6
---

# Templates

AppKit uses a template system powered by the Databricks CLI's `databricks apps init` command. Templates define the project structure, and `.tmpl` files are processed with Go's `text/template` engine to generate customized output.

## How `.tmpl` files work

Any file ending in `.tmpl` is processed by the CLI during `databricks apps init`:

1. The `.tmpl` suffix is stripped (e.g. `.env.tmpl` → `.env`)
2. Go template expressions are evaluated and substituted
3. The rendered file is written to the output directory

Files named with a `_` prefix are renamed to `.` prefix (e.g. `_gitignore` → `.gitignore`).

### Template variables

| Variable | Description |
|----------|-------------|
| `.projectName` | Project name from `--name` or interactive prompt |
| `.workspaceHost` | Databricks workspace URL |
| `.profile` | Databricks CLI profile name (empty if using host-based auth) |
| `.appDescription` | App description |
| `.plugins.<name>` | Non-nil for each selected plugin, enabling conditionals |
| `.dotEnv.content` | Generated `.env` content from plugin resources |
| `.dotEnv.example` | Generated `.env.example` content with placeholders |
| `.bundle.*` | Generated `databricks.yml` sections (variables, resources, target variables) |
| `.appEnv` | Generated `app.yaml` env entries |

### Conditional content

Use Go template conditionals to include/exclude code based on selected plugins:

```go
{{- if .plugins.analytics}}
import { analytics } from '@databricks/appkit';
{{- end}}
```

## `appkit.plugins.json`

The plugin manifest drives the CLI's behavior during `databricks apps init`:

- **Plugin selection UI** — selectable plugins shown in the interactive prompt
- **Resource prompts** — required/optional resources prompt the user for values (e.g. SQL Warehouse ID)
- **`.dotEnv` population** — resource fields with an `env` property are written to `.env`
- **`app.yaml` generation** — resource fields produce `env` + `valueFrom` entries
- **`databricks.yml` generation** — resource fields produce bundle variables and app resource entries

### Resource field properties

Each resource field in the manifest can have these properties:

| Property | Description |
|----------|-------------|
| `env` | Environment variable name written to `.env` and `app.yaml` |
| `description` | Shown in the interactive prompt and bundle variable description |
| `localOnly` | Only written to `.env` for local dev; excluded from `app.yaml` and bundle variables |
| `bundleIgnore` | Excluded from `databricks.yml` variables (but still in `.env`) |
| `value` | Default value used when no user input is provided |
| `resolve` | Auto-populated by CLI from API calls instead of prompting (see below) |
| `examples` | Example values shown in field descriptions |

### Resolvers

Fields with a `resolve` property are auto-populated by the CLI from API calls rather than user prompts. The format is `<type>:<field>`.

Currently only the `postgres` resource type has a resolver. Given the user-provided `branch` and `database` resource names, it derives:

| Resolve key | Description |
|-------------|-------------|
| `postgres:host` | Postgres host from the branch's read-write endpoint |
| `postgres:databaseName` | Postgres database name from the database resource |
| `postgres:endpointPath` | Lakebase endpoint resource name from the branch's endpoints |

Example field definition:

```json
{
  "host": {
    "env": "PGHOST",
    "localOnly": true,
    "resolve": "postgres:host",
    "description": "Postgres host for local development."
  }
}
```

## See also

- [Plugin management](../plugins/plugin-management.md) — `appkit plugin sync`, `appkit plugin create`
- [Configuration](../configuration.mdx) — environment variables

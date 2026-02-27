---
sidebar_position: 6
---

# Plugin management

AppKit includes a CLI for managing plugins. All commands are available under `npx @databricks/appkit plugin`.

**Manifest convention:** `manifest.json` is the default and recommended format for CLI commands (`sync`, `list`, `validate`). For zero-trust safety, JS manifests (`manifest.js`/`manifest.cjs`) are ignored unless you pass `--allow-js-manifest`, which executes plugin code and should be used only with trusted sources. The **add-resource** command only edits `manifest.json` in place.

## Create a plugin

Scaffold a new plugin interactively:

```bash
npx @databricks/appkit plugin create
```

The wizard walks you through:
- **Placement**: In your repository (e.g. `plugins/my-plugin`) or as a standalone package
- **Metadata**: Name, display name, description
- **Resources**: Which Databricks resources the plugin needs (SQL Warehouse, Secret, etc.) and whether each is required or optional
- **Optional fields**: Author, version, license

The command generates a complete plugin scaffold with `manifest.json` and a TypeScript plugin class that imports the manifest directly — ready to register in your app.

## Sync plugin manifests

Scan your project for plugins and generate `appkit.plugins.json`:

```bash
npx @databricks/appkit plugin sync --write
```

This discovers plugin manifests from installed packages and local imports, then writes a consolidated manifest used by deployment tooling. Plugins referenced in your `createApp({ plugins: [...] })` call are automatically marked as required.

Trusted installed Databricks packages (for example `@databricks/appkit`) are allowed to load bundled JS manifests during `plugin sync`. For other sources, if you intentionally rely on JS manifests, opt in explicitly:

```bash
npx @databricks/appkit plugin sync --write --allow-js-manifest
```

Use the `--silent` flag in build hooks to suppress output:

```json
{
  "scripts": {
    "sync": "appkit plugin sync --write --silent",
    "predev": "npm run sync",
    "prebuild": "npm run sync"
  }
}
```

## Validate manifests

Check plugin manifests against the JSON schema:

```bash
# Validate manifest.json in the current directory
npx @databricks/appkit plugin validate

# Validate specific files or directories
npx @databricks/appkit plugin validate plugins/my-plugin appkit.plugins.json
```

The validator auto-detects whether a file is a plugin manifest or a template manifest (from `$schema`) and reports errors with humanized paths and expected values.

To include JS manifests in validation, pass `--allow-js-manifest`.

## List plugins

View registered plugins from `appkit.plugins.json` or scan a directory:

```bash
# From appkit.plugins.json (default)
npx @databricks/appkit plugin list

# Scan a directory for plugin folders
npx @databricks/appkit plugin list --dir plugins/

# Scan a directory and include JS manifests (trusted code only)
npx @databricks/appkit plugin list --dir plugins/ --allow-js-manifest

# JSON output for scripting
npx @databricks/appkit plugin list --json
```

## Add a resource to a plugin

Interactively add a new resource requirement to an existing plugin manifest. **Requires `manifest.json`** in the plugin directory (the command edits it in place; it does not modify `manifest.js`):

```bash
npx @databricks/appkit plugin add-resource

# Or specify the plugin directory
npx @databricks/appkit plugin add-resource --path plugins/my-plugin
```

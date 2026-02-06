import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

/**
 * Resource requirement as defined in plugin manifests
 */
interface ResourceRequirement {
  type: string;
  alias: string;
  description: string;
  permission: string;
  env?: string;
}

/**
 * Plugin manifest structure (from SDK plugin manifest.json files)
 */
interface PluginManifest {
  name: string;
  displayName: string;
  description: string;
  resources: {
    required: ResourceRequirement[];
    optional: ResourceRequirement[];
  };
  config?: { schema: unknown };
}

/**
 * Plugin entry in the template manifest (includes package source)
 */
interface TemplatePlugin extends Omit<PluginManifest, "config"> {
  package: string;
}

/**
 * Template plugins manifest structure
 */
interface TemplatePluginsManifest {
  $schema: string;
  version: string;
  plugins: Record<string, TemplatePlugin>;
}

/**
 * Known packages that may contain AppKit plugins.
 * The sync command will scan these packages for plugin manifests.
 */
const KNOWN_PLUGIN_PACKAGES = [
  "@databricks/appkit",
  // Community packages can be added here or discovered dynamically in the future
];

/**
 * Discover plugin manifests from a package's dist folder.
 * Looks for manifest.json files in dist/plugins/{plugin-name}/ directories.
 *
 * @param packagePath - Path to the package in node_modules
 * @returns Array of plugin manifests found in the package
 */
function discoverPluginManifests(packagePath: string): PluginManifest[] {
  const pluginsDir = path.join(packagePath, "dist", "plugins");
  const manifests: PluginManifest[] = [];

  if (!fs.existsSync(pluginsDir)) {
    return manifests;
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const manifestPath = path.join(pluginsDir, entry.name, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const content = fs.readFileSync(manifestPath, "utf-8");
          const manifest = JSON.parse(content) as PluginManifest;
          manifests.push(manifest);
        } catch (error) {
          console.warn(
            `Warning: Failed to parse manifest at ${manifestPath}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }

  return manifests;
}

/**
 * Scan node_modules for packages with plugin manifests.
 * Iterates through known plugin packages and discovers their manifests.
 *
 * @param cwd - Current working directory to search from
 * @returns Map of plugin name to template plugin entry
 */
function scanForPlugins(cwd: string): TemplatePluginsManifest["plugins"] {
  const plugins: TemplatePluginsManifest["plugins"] = {};

  for (const packageName of KNOWN_PLUGIN_PACKAGES) {
    const packagePath = path.join(cwd, "node_modules", packageName);
    if (!fs.existsSync(packagePath)) {
      continue;
    }

    const manifests = discoverPluginManifests(packagePath);
    for (const manifest of manifests) {
      // Convert to template plugin format (exclude config schema)
      plugins[manifest.name] = {
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        package: packageName,
        resources: manifest.resources,
      };
    }
  }

  return plugins;
}

/**
 * Run the plugins sync command.
 * Scans for plugin manifests and generates/updates appkit.plugins.json.
 */
function runPluginsSync(options: { write?: boolean; output?: string }) {
  const cwd = process.cwd();
  const outputPath = options.output || path.join(cwd, "appkit.plugins.json");

  console.log("Scanning for AppKit plugins...\n");

  const plugins = scanForPlugins(cwd);
  const pluginCount = Object.keys(plugins).length;

  if (pluginCount === 0) {
    console.log("No plugins found in node_modules.");
    console.log("\nMake sure you have plugin packages installed:");
    for (const pkg of KNOWN_PLUGIN_PACKAGES) {
      console.log(`  - ${pkg}`);
    }
    process.exit(1);
  }

  console.log(`Found ${pluginCount} plugin(s):`);
  for (const [name, manifest] of Object.entries(plugins)) {
    const resourceCount =
      manifest.resources.required.length + manifest.resources.optional.length;
    const resourceInfo =
      resourceCount > 0 ? ` [${resourceCount} resource(s)]` : "";
    console.log(
      `  ✓ ${manifest.displayName} (${name}) from ${manifest.package}${resourceInfo}`,
    );
  }

  const templateManifest: TemplatePluginsManifest = {
    $schema:
      "https://databricks.github.io/appkit/schemas/template-plugins.schema.json",
    version: "1.0",
    plugins,
  };

  if (options.write) {
    fs.writeFileSync(
      outputPath,
      JSON.stringify(templateManifest, null, 2) + "\n",
    );
    console.log(`\n✓ Wrote ${outputPath}`);
  } else {
    console.log("\nTo write the manifest, run:");
    console.log("  npx appkit plugins sync --write\n");
    console.log("Preview:");
    console.log("─".repeat(60));
    console.log(JSON.stringify(templateManifest, null, 2));
    console.log("─".repeat(60));
  }
}

export const pluginsSyncCommand = new Command("sync")
  .description(
    "Sync plugin manifests from installed packages into appkit.plugins.json",
  )
  .option("-w, --write", "Write the manifest file")
  .option(
    "-o, --output <path>",
    "Output file path (default: ./appkit.plugins.json)",
  )
  .action(runPluginsSync);

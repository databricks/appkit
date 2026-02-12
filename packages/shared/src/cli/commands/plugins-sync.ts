import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { Command } from "commander";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve to package schemas: from dist/cli/commands -> dist/schemas, from src/cli/commands -> shared/schemas
const PLUGIN_MANIFEST_SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "schemas",
  "plugin-manifest.schema.json",
);

/**
 * Field entry in a resource requirement (env var + optional description)
 */
interface ResourceFieldEntry {
  env: string;
  description?: string;
}

/**
 * Resource requirement as defined in plugin manifests.
 * Uses fields (single key e.g. id, or multiple e.g. instance_name/database_name, scope/key).
 */
interface ResourceRequirement {
  type: string;
  alias: string;
  resourceKey: string;
  description: string;
  permission: string;
  fields: Record<string, ResourceFieldEntry>;
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
  /** When true, this plugin is required by the template and cannot be deselected during CLI init. */
  requiredByTemplate?: boolean;
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
 * Checks whether a resolved file path is within a given directory boundary.
 * Uses path.resolve + startsWith to prevent directory traversal.
 *
 * @param filePath - The path to check (will be resolved to absolute)
 * @param boundary - The directory that must contain filePath
 * @returns true if filePath is inside boundary (or equal to it)
 */
function isWithinDirectory(filePath: string, boundary: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedBoundary = path.resolve(boundary);
  // Append separator to avoid prefix false-positives (e.g. /foo-bar matching /foo)
  return (
    resolvedPath === resolvedBoundary ||
    resolvedPath.startsWith(`${resolvedBoundary}${path.sep}`)
  );
}

let pluginManifestValidator: ReturnType<Ajv["compile"]> | null = null;

/**
 * Loads and compiles the plugin-manifest JSON schema (cached).
 * Returns the compiled validate function or null if the schema cannot be loaded.
 */
function getPluginManifestValidator(): ReturnType<Ajv["compile"]> | null {
  if (pluginManifestValidator) return pluginManifestValidator;
  try {
    const schemaRaw = fs.readFileSync(PLUGIN_MANIFEST_SCHEMA_PATH, "utf-8");
    const schema = JSON.parse(schemaRaw) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    pluginManifestValidator = ajv.compile(schema);
    return pluginManifestValidator;
  } catch (err) {
    console.warn(
      "Warning: Could not load plugin-manifest schema for validation:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Validates a parsed JSON object against the plugin-manifest JSON schema.
 * Returns the manifest if valid, or null and logs schema errors.
 *
 * @param obj - The parsed JSON object to validate
 * @param sourcePath - Path to the manifest file (for warning messages)
 * @returns A valid PluginManifest or null
 */
function validateManifestWithSchema(
  obj: unknown,
  sourcePath: string,
): PluginManifest | null {
  if (!obj || typeof obj !== "object") {
    console.warn(`Warning: Manifest at ${sourcePath} is not a valid object`);
    return null;
  }

  const validate = getPluginManifestValidator();
  if (!validate) {
    // Schema not available (e.g. dev without build); fall back to basic shape check
    const m = obj as Record<string, unknown>;
    if (
      typeof m.name === "string" &&
      m.name.length > 0 &&
      typeof m.displayName === "string" &&
      m.displayName.length > 0 &&
      typeof m.description === "string" &&
      m.description.length > 0 &&
      m.resources &&
      typeof m.resources === "object" &&
      Array.isArray((m.resources as { required?: unknown }).required)
    ) {
      return obj as PluginManifest;
    }
    console.warn(`Warning: Manifest at ${sourcePath} has invalid structure`);
    return null;
  }

  const valid = validate(obj);
  if (valid) return obj as PluginManifest;

  const errors: ErrorObject[] = validate.errors ?? [];
  const message = errors
    .map(
      (e: ErrorObject) =>
        `  ${e.instancePath || "/"} ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`,
    )
    .join("\n");
  console.warn(
    `Warning: Manifest at ${sourcePath} failed schema validation:\n${message}`,
  );
  return null;
}

/**
 * Known packages that may contain AppKit plugins.
 * Always scanned for manifests, even if not imported in the server file.
 */
const KNOWN_PLUGIN_PACKAGES = ["@databricks/appkit"];

/**
 * Candidate paths for the server entry file, relative to cwd.
 * Checked in order; the first that exists is used.
 */
const SERVER_FILE_CANDIDATES = ["server/server.ts"];

/**
 * Find the server entry file by checking candidate paths in order.
 *
 * @param cwd - Current working directory
 * @returns Absolute path to the server file, or null if none found
 */
function findServerFile(cwd: string): string | null {
  for (const candidate of SERVER_FILE_CANDIDATES) {
    const fullPath = path.join(cwd, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Represents a single named import extracted from the server file.
 */
interface ParsedImport {
  /** The imported name (or local alias if renamed) */
  name: string;
  /** The original exported name (differs from name when using `import { foo as bar }`) */
  originalName: string;
  /** The module specifier (package name or relative path) */
  source: string;
}

/**
 * Extract all named imports from the AST root using structural node traversal.
 * Handles single/double quotes, multiline imports, and aliased imports.
 *
 * @param root - AST root node
 * @returns Array of parsed imports with name, original name, and source
 */
function parseImports(root: SgNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // Find all import_statement nodes in the AST
  const importStatements = root.findAll({
    rule: { kind: "import_statement" },
  });

  for (const stmt of importStatements) {
    // Extract the module specifier (the string node, e.g. '@databricks/appkit')
    const sourceNode = stmt.find({ rule: { kind: "string" } });
    if (!sourceNode) continue;

    // Strip surrounding quotes from the string node text
    const source = sourceNode.text().replace(/^['"]|['"]$/g, "");

    // Find named_imports block: { createApp, analytics, server }
    const namedImports = stmt.find({ rule: { kind: "named_imports" } });
    if (!namedImports) continue;

    // Extract each import_specifier
    const specifiers = namedImports.findAll({
      rule: { kind: "import_specifier" },
    });

    for (const specifier of specifiers) {
      const children = specifier.children();
      if (children.length >= 3) {
        // Aliased import: `foo as bar` — children are [name, "as", alias]
        const originalName = children[0].text();
        const localName = children[children.length - 1].text();
        imports.push({ name: localName, originalName, source });
      } else {
        // Simple import: `foo`
        const name = specifier.text();
        imports.push({ name, originalName: name, source });
      }
    }
  }

  return imports;
}

/**
 * Extract local names of plugins actually used in the `plugins: [...]` array
 * passed to `createApp()`. Uses structural AST traversal to find `pair` nodes
 * with key "plugins" and array values containing call expressions.
 *
 * @param root - AST root node
 * @returns Set of local variable names used as plugin calls in the plugins array
 */
function parsePluginUsages(root: SgNode): Set<string> {
  const usedNames = new Set<string>();

  // Find all property pairs in the AST
  const pairs = root.findAll({ rule: { kind: "pair" } });

  for (const pair of pairs) {
    // Check if the property key is "plugins"
    const key = pair.find({ rule: { kind: "property_identifier" } });
    if (!key || key.text() !== "plugins") continue;

    // Find the array value
    const arrayNode = pair.find({ rule: { kind: "array" } });
    if (!arrayNode) continue;

    // Iterate direct children of the array to find call expressions
    for (const child of arrayNode.children()) {
      if (child.kind() === "call_expression") {
        // The callee is the first child (the identifier being called)
        const callee = child.children()[0];
        if (callee?.kind() === "identifier") {
          usedNames.add(callee.text());
        }
      }
    }
  }

  return usedNames;
}

/**
 * File extensions to try when resolving a relative import to a file path.
 */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Resolve a relative import source to the plugin directory containing a manifest.json.
 * Follows the convention that plugins live in their own directory with a manifest.json.
 *
 * Resolution strategy:
 * 1. If the import path is a directory, look for manifest.json directly in it
 * 2. If the import path + extension is a file, look for manifest.json in its parent directory
 * 3. If the import path is a directory with an index file, look for manifest.json in that directory
 *
 * @param importSource - The relative import specifier (e.g. "./plugins/my-plugin")
 * @param serverFileDir - Absolute path to the directory containing the server file
 * @returns Absolute path to manifest.json, or null if not found
 */
function resolveLocalManifest(
  importSource: string,
  serverFileDir: string,
  projectRoot?: string,
): string | null {
  const resolved = path.resolve(serverFileDir, importSource);

  // Security: Reject paths that escape the project root
  const boundary = projectRoot || serverFileDir;
  if (!isWithinDirectory(resolved, boundary)) {
    console.warn(
      `Warning: Skipping import "${importSource}" — resolves outside the project directory`,
    );
    return null;
  }

  // Case 1: Import path is a directory with manifest.json
  // e.g. ./plugins/my-plugin → ./plugins/my-plugin/manifest.json
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const manifestPath = path.join(resolved, "manifest.json");
    if (fs.existsSync(manifestPath)) return manifestPath;
  }

  // Case 2: Import path + extension resolves to a file
  // e.g. ./plugins/my-plugin → ./plugins/my-plugin.ts
  // Look for manifest.json in the same directory
  for (const ext of RESOLVE_EXTENSIONS) {
    const filePath = `${resolved}${ext}`;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const dir = path.dirname(filePath);
      const manifestPath = path.join(dir, "manifest.json");
      if (fs.existsSync(manifestPath)) return manifestPath;
      break;
    }
  }

  // Case 3: Import path is a directory with an index file
  // e.g. ./plugins/my-plugin → ./plugins/my-plugin/index.ts
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = path.join(resolved, `index${ext}`);
    if (fs.existsSync(indexPath)) {
      const manifestPath = path.join(resolved, "manifest.json");
      if (fs.existsSync(manifestPath)) return manifestPath;
      break;
    }
  }

  return null;
}

/**
 * Discover plugin manifests from local (relative) imports in the server file.
 * Resolves each relative import to a directory and looks for manifest.json.
 *
 * @param relativeImports - Parsed imports with relative sources (starting with . or /)
 * @param serverFileDir - Absolute path to the directory containing the server file
 * @param cwd - Current working directory (for computing relative paths in output)
 * @returns Map of plugin name to template plugin entry for local plugins
 */
function discoverLocalPlugins(
  relativeImports: ParsedImport[],
  serverFileDir: string,
  cwd: string,
): TemplatePluginsManifest["plugins"] {
  const plugins: TemplatePluginsManifest["plugins"] = {};

  for (const imp of relativeImports) {
    const manifestPath = resolveLocalManifest(imp.source, serverFileDir, cwd);
    if (!manifestPath) continue;

    try {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(content);
      const manifest = validateManifestWithSchema(parsed, manifestPath);
      if (!manifest) continue;

      const relativePath = path.relative(cwd, path.dirname(manifestPath));

      plugins[manifest.name] = {
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        package: `./${relativePath}`,
        resources: manifest.resources,
      };
    } catch (error) {
      console.warn(
        `Warning: Failed to parse manifest at ${manifestPath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return plugins;
}

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
          const parsed = JSON.parse(content);
          const manifest = validateManifestWithSchema(parsed, manifestPath);
          if (manifest) {
            manifests.push(manifest);
          }
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
 *
 * @param cwd - Current working directory to search from
 * @param packages - Set of npm package names to scan for plugin manifests
 * @returns Map of plugin name to template plugin entry
 */
function scanForPlugins(
  cwd: string,
  packages: Iterable<string>,
): TemplatePluginsManifest["plugins"] {
  const plugins: TemplatePluginsManifest["plugins"] = {};

  for (const packageName of packages) {
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
 * Parses the server entry file to discover which packages to scan for plugin
 * manifests, then marks plugins that are actually used in the `plugins: [...]`
 * array as requiredByTemplate.
 */
function runPluginsSync(options: { write?: boolean; output?: string }) {
  const cwd = process.cwd();
  const outputPath = path.resolve(cwd, options.output || "appkit.plugins.json");

  // Security: Reject output paths that escape the project root
  if (!isWithinDirectory(outputPath, cwd)) {
    console.error(
      `Error: Output path "${options.output}" resolves outside the project directory.`,
    );
    process.exit(1);
  }

  console.log("Scanning for AppKit plugins...\n");

  // Step 1: Parse server file to discover imports and plugin usages
  const serverFile = findServerFile(cwd);
  let serverImports: ParsedImport[] = [];
  let pluginUsages = new Set<string>();

  if (serverFile) {
    const relativePath = path.relative(cwd, serverFile);
    console.log(`Server entry file: ${relativePath}`);

    const content = fs.readFileSync(serverFile, "utf-8");
    const lang = serverFile.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript;
    const ast = parse(lang, content);
    const root = ast.root();

    serverImports = parseImports(root);
    pluginUsages = parsePluginUsages(root);
  } else {
    console.log(
      "No server entry file found. Checked:",
      SERVER_FILE_CANDIDATES.join(", "),
    );
  }

  // Step 2: Split imports into npm packages and local (relative) imports
  const npmImports = serverImports.filter(
    (i) => !i.source.startsWith(".") && !i.source.startsWith("/"),
  );
  const localImports = serverImports.filter(
    (i) => i.source.startsWith(".") || i.source.startsWith("/"),
  );

  // Step 3: Scan npm packages for plugin manifests
  const npmPackages = new Set([
    ...KNOWN_PLUGIN_PACKAGES,
    ...npmImports.map((i) => i.source),
  ]);
  const plugins = scanForPlugins(cwd, npmPackages);

  // Step 4: Discover local plugin manifests from relative imports
  if (serverFile && localImports.length > 0) {
    const serverFileDir = path.dirname(serverFile);
    const localPlugins = discoverLocalPlugins(localImports, serverFileDir, cwd);
    Object.assign(plugins, localPlugins);
  }

  const pluginCount = Object.keys(plugins).length;

  if (pluginCount === 0) {
    console.log("No plugins found.");
    console.log("\nMake sure you have plugin packages installed:");
    for (const pkg of npmPackages) {
      console.log(`  - ${pkg}`);
    }
    process.exit(1);
  }

  // Step 5: Mark plugins that are imported AND used in the plugins array as mandatory.
  // For npm imports, match by package name + plugin name.
  // For local imports, resolve both paths to absolute and compare.
  const serverFileDir = serverFile ? path.dirname(serverFile) : cwd;

  for (const imp of serverImports) {
    if (!pluginUsages.has(imp.name)) continue;

    const isLocal = imp.source.startsWith(".") || imp.source.startsWith("/");
    let plugin: TemplatePlugin | undefined;

    if (isLocal) {
      // Resolve the import source to an absolute path from the server file directory
      const resolvedImportDir = path.resolve(serverFileDir, imp.source);
      plugin = Object.values(plugins).find((p) => {
        if (!p.package.startsWith(".")) return false;
        const resolvedPluginDir = path.resolve(cwd, p.package);
        return (
          resolvedPluginDir === resolvedImportDir && p.name === imp.originalName
        );
      });
    } else {
      // npm import: direct string comparison
      plugin = Object.values(plugins).find(
        (p) => p.package === imp.source && p.name === imp.originalName,
      );
    }

    if (plugin) {
      plugin.requiredByTemplate = true;
    }
  }

  console.log(`\nFound ${pluginCount} plugin(s):`);
  for (const [name, manifest] of Object.entries(plugins)) {
    const resourceCount =
      manifest.resources.required.length + manifest.resources.optional.length;
    const resourceInfo =
      resourceCount > 0 ? ` [${resourceCount} resource(s)]` : "";
    const mandatoryTag = manifest.requiredByTemplate ? " (mandatory)" : "";
    console.log(
      `  ${manifest.requiredByTemplate ? "●" : "○"} ${manifest.displayName} (${name}) from ${manifest.package}${resourceInfo}${mandatoryTag}`,
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
      `${JSON.stringify(templateManifest, null, 2)}\n`,
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

/** Exported for testing: path boundary check, AST parsing. */
export { isWithinDirectory, parseImports, parsePluginUsages };

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

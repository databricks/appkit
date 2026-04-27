import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import {
  loadManifestFromFile,
  type ResolvedManifest,
  resolveManifestInDir,
} from "../manifest-resolve";
import {
  detectSchemaType,
  formatValidationErrors,
  validateManifest,
  validateTemplateManifest,
} from "./validate-manifest";

function resolveManifestPaths(
  paths: string[],
  cwd: string,
  allowJsManifest: boolean,
): ResolvedManifest[] {
  const out: ResolvedManifest[] = [];
  for (const p of paths) {
    const resolved = path.resolve(cwd, p);
    if (!fs.existsSync(resolved)) {
      console.error(`Path not found: ${p}`);
      continue;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      let found = false;
      const pluginResolved = resolveManifestInDir(resolved, {
        allowJsManifest,
      });
      if (pluginResolved) {
        out.push(pluginResolved);
        found = true;
      }
      const templateManifest = path.join(resolved, "appkit.plugins.json");
      if (fs.existsSync(templateManifest)) {
        out.push({ path: templateManifest, type: "json" });
        found = true;
      }
      if (!found) {
        console.error(
          `No ${allowJsManifest ? "manifest.json, manifest.js, or" : "manifest.json or"} appkit.plugins.json in directory: ${p}`,
        );
      }
    } else {
      const ext = path.extname(resolved).toLowerCase();
      if (!allowJsManifest && (ext === ".js" || ext === ".cjs")) {
        console.error(
          `JS manifest provided but disabled by default: ${p}. Re-run with --allow-js-manifest to opt in.`,
        );
        continue;
      }
      out.push({
        path: resolved,
        type: ext === ".js" || ext === ".cjs" ? "js" : "json",
      });
    }
  }
  return out;
}

interface ValidateOptions {
  allowJsManifest?: boolean;
  json?: boolean;
}

async function runPluginValidate(
  paths: string[],
  options: ValidateOptions,
): Promise<void> {
  const cwd = process.cwd();
  const allowJsManifest = Boolean(options.allowJsManifest);
  if (allowJsManifest && !options.json) {
    console.warn(
      "Warning: --allow-js-manifest executes manifest.js/manifest.cjs files. Only use with trusted code.",
    );
  }
  const toValidate = paths.length > 0 ? paths : ["."];
  const manifestPaths = resolveManifestPaths(toValidate, cwd, allowJsManifest);

  if (manifestPaths.length === 0) {
    if (options.json) {
      console.log("[]");
    } else {
      console.error("No manifest files to validate.");
    }
    process.exit(1);
  }

  let hasFailure = false;
  const jsonResults: { path: string; valid: boolean; errors?: string[] }[] = [];

  for (const { path: manifestPath, type } of manifestPaths) {
    const relativePath = path.relative(cwd, manifestPath);
    let obj: unknown;
    try {
      obj = await loadManifestFromFile(manifestPath, type, { allowJsManifest });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (options.json) {
        jsonResults.push({
          path: relativePath,
          valid: false,
          errors: [errMsg],
        });
      } else {
        console.error(`✗ ${manifestPath}`);
        console.error(`  ${errMsg}`);
      }
      hasFailure = true;
      continue;
    }

    const schemaType = detectSchemaType(obj);
    const result =
      schemaType === "template-plugins"
        ? validateTemplateManifest(obj)
        : validateManifest(obj);

    if (result.valid) {
      if (options.json) {
        jsonResults.push({ path: relativePath, valid: true });
      } else {
        console.log(`✓ ${relativePath}`);
      }
    } else {
      if (options.json) {
        const errors = result.errors?.length
          ? formatValidationErrors(result.errors, obj)
              .split("\n")
              .filter(Boolean)
          : [];
        jsonResults.push({
          path: relativePath,
          valid: false,
          ...(errors.length > 0 && { errors }),
        });
      } else {
        console.error(`✗ ${relativePath}`);
        if (result.errors?.length) {
          console.error(formatValidationErrors(result.errors, obj));
        }
      }
      hasFailure = true;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(jsonResults, null, 2));
  }

  process.exit(hasFailure ? 1 : 0);
}

export const pluginValidateCommand = new Command("validate")
  .description(
    "Validate plugin manifest(s) or template manifests against their JSON schema",
  )
  .argument(
    "[paths...]",
    "Paths to manifest.json or appkit.plugins.json (or plugin directories); use --allow-js-manifest to include manifest.js",
  )
  .option(
    "--allow-js-manifest",
    "Allow reading manifest.js/manifest.cjs (executes code; use only with trusted plugins)",
  )
  .option("--json", "Output validation results as JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit plugin validate
  $ appkit plugin validate plugins/my-plugin
  $ appkit plugin validate plugins/my-plugin plugins/other
  $ appkit plugin validate appkit.plugins.json
  $ appkit plugin validate --json`,
  )
  .action((paths: string[], opts: ValidateOptions) =>
    runPluginValidate(paths, opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import {
  detectSchemaType,
  formatValidationErrors,
  validateManifest,
  validateTemplateManifest,
} from "./validate-manifest";

function resolveManifestPaths(paths: string[], cwd: string): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(cwd, p);
    if (!fs.existsSync(resolved)) {
      console.error(`Path not found: ${p}`);
      continue;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const pluginManifest = path.join(resolved, "manifest.json");
      const templateManifest = path.join(resolved, "appkit.plugins.json");
      let found = false;
      if (fs.existsSync(pluginManifest)) {
        out.push(pluginManifest);
        found = true;
      }
      if (fs.existsSync(templateManifest)) {
        out.push(templateManifest);
        found = true;
      }
      if (!found) {
        console.error(
          `No manifest.json or appkit.plugins.json in directory: ${p}`,
        );
      }
    } else {
      out.push(resolved);
    }
  }
  return out;
}

function runPluginValidate(paths: string[]): void {
  const cwd = process.cwd();
  const toValidate = paths.length > 0 ? paths : ["."];
  const manifestPaths = resolveManifestPaths(toValidate, cwd);

  if (manifestPaths.length === 0) {
    console.error("No manifest files to validate.");
    process.exit(1);
  }

  let hasFailure = false;
  for (const manifestPath of manifestPaths) {
    let obj: unknown;
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      obj = JSON.parse(raw);
    } catch (err) {
      console.error(`✗ ${manifestPath}`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      hasFailure = true;
      continue;
    }

    const schemaType = detectSchemaType(obj);
    const result =
      schemaType === "template-plugins"
        ? validateTemplateManifest(obj)
        : validateManifest(obj);

    const relativePath = path.relative(cwd, manifestPath);
    if (result.valid) {
      console.log(`✓ ${relativePath}`);
    } else {
      console.error(`✗ ${relativePath}`);
      if (result.errors?.length) {
        console.error(formatValidationErrors(result.errors, obj));
      }
      hasFailure = true;
    }
  }

  process.exit(hasFailure ? 1 : 0);
}

export const pluginValidateCommand = new Command("validate")
  .description(
    "Validate plugin manifest(s) or template manifests against their JSON schema",
  )
  .argument(
    "[paths...]",
    "Paths to manifest.json, appkit.plugins.json, or plugin directories (default: .)",
  )
  .action(runPluginValidate);

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import {
  formatValidationErrors,
  validateManifest,
} from "../plugin-validate/validate-manifest.js";

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
      const manifestPath = path.join(resolved, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        out.push(manifestPath);
      } else {
        console.error(`No manifest.json in directory: ${p}`);
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

    const result = validateManifest(obj, manifestPath);
    const relativePath = path.relative(cwd, manifestPath);
    if (result.valid) {
      console.log(`✓ ${relativePath}`);
    } else {
      console.error(`✗ ${relativePath}`);
      if (result.errors?.length) {
        console.error(formatValidationErrors(result.errors));
      }
      hasFailure = true;
    }
  }

  process.exit(hasFailure ? 1 : 0);
}

export const pluginValidateCommand = new Command("validate")
  .description("Validate plugin manifest(s) against the JSON schema")
  .argument(
    "[paths...]",
    "Paths to manifest.json or plugin directories (default: .)",
  )
  .action(runPluginValidate);

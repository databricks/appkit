#!/usr/bin/env tsx
/**
 * Syncs the version from root package.json to all publishable packages.
 * Used by release-it after version bump.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PACKAGES = ["packages/appkit", "packages/appkit-ui"];

// Get version from command line arg or root package.json
const version =
  process.argv[2] ||
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;

console.log(`Syncing version ${version} to packages...`);

for (const pkg of PACKAGES) {
  const pkgJsonPath = join(ROOT, pkg, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  pkgJson.version = version;
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  console.log(`  ✓ ${pkg}/package.json → ${version}`);
}

console.log("Done!");

#!/usr/bin/env tsx
/**
 * Syncs the version to the lakebase package.
 * Used by the prepare-release-lakebase workflow after version bump.
 */

/**
 * NOTE: This script is also used by the private secure release repo
 * during the finalize step. Changes here affect the release pipeline.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const version = process.argv[2];
if (!version) {
  console.error("Usage: sync-lakebase-version.ts <version>");
  process.exit(1);
}

const pkgJsonPath = join(ROOT, "packages/lakebase/package.json");
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
pkgJson.version = version;
writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
console.log(`✓ packages/lakebase/package.json → ${version}`);

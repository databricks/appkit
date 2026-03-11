#!/usr/bin/env tsx
/**
 * Prepares a PR template artifact for testing.
 *
 * Copies the template/ directory into a staging folder, bundles the SDK tarballs
 * built by `pnpm pack:sdk`, and rewrites package.json to use `file:` references
 * so the template can be tested against the PR's version of appkit/appkit-ui.
 *
 * Usage:
 *   tsx tools/prepare-pr-template.ts <version>
 *
 * The version should match the one used when building the tarballs (e.g. 0.18.0-my-branch).
 */

import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const version = process.argv[2];
if (!version) {
  console.error("Usage: tsx tools/prepare-pr-template.ts <version>");
  process.exit(1);
}

const STAGING_DIR = join(ROOT, "pr-template");
const APPKIT_TARBALL = `databricks-appkit-${version}.tgz`;
const APPKIT_UI_TARBALL = `databricks-appkit-ui-${version}.tgz`;

// 1. Copy template into staging directory
mkdirSync(STAGING_DIR, { recursive: true });
cpSync(join(ROOT, "template"), STAGING_DIR, { recursive: true });
console.log("✓ Copied template/ → pr-template/");

// 2. Copy tarballs into staging directory
copyFileSync(
  join(ROOT, "packages/appkit/tmp", APPKIT_TARBALL),
  join(STAGING_DIR, APPKIT_TARBALL),
);
copyFileSync(
  join(ROOT, "packages/appkit-ui/tmp", APPKIT_UI_TARBALL),
  join(STAGING_DIR, APPKIT_UI_TARBALL),
);
console.log(`✓ Copied ${APPKIT_TARBALL} and ${APPKIT_UI_TARBALL}`);

// 3. Rewrite package.json dependencies to point at the local tarballs
const pkgPath = join(STAGING_DIR, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
pkg.dependencies["@databricks/appkit"] = `file:./${APPKIT_TARBALL}`;
pkg.dependencies["@databricks/appkit-ui"] = `file:./${APPKIT_UI_TARBALL}`;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("✓ Rewrote package.json dependencies to file: references");

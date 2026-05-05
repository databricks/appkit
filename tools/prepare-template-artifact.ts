#!/usr/bin/env tsx
/**
 * Prepares a template artifact for testing or release.
 *
 * Copies the template/ directory into a staging folder, bundles the SDK tarballs,
 * and rewrites package.json to use `file:` references for appkit and appkit-ui.
 *
 * When `packages/lakebase/tmp/databricks-lakebase-<version>.tgz` exists (e.g. after
 * `pnpm pack:sdk` on a dev checkout), that tarball is copied into the staging folder and
 * `overrides["@databricks/lakebase"]` is set so the template install uses the local pack
 * instead of the registry. Release jobs that only download appkit tarballs skip this
 * branch and keep the default semver resolution from the appkit tarball.
 *
 * Usage:
 *   tsx tools/prepare-template-artifact.ts --version <ver> [--tarball-dir <path>] [--output-dir <path>]
 *
 * Options:
 *   --version      Required. Version string used to locate tarball filenames.
 *   --tarball-dir  Optional. Single directory containing both tarballs.
 *                  Defaults to packages/appkit/tmp/ and packages/appkit-ui/tmp/.
 *   --output-dir   Optional. Staging directory name. Defaults to "pr-template".
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = process.cwd();

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "tarball-dir": { type: "string" },
    "output-dir": { type: "string", default: "pr-template" },
  },
  strict: true,
});

const version = values.version;
if (!version) {
  console.error(
    "Usage: tsx tools/prepare-template-artifact.ts --version <ver> [--tarball-dir <path>] [--output-dir <path>]",
  );
  process.exit(1);
}

const tarballDir = values["tarball-dir"];
// biome-ignore lint/style/noNonNullAssertion: default value guarantees this is defined
const outputDir = values["output-dir"]!;

const STAGING_DIR = join(ROOT, outputDir);
const APPKIT_TARBALL = `databricks-appkit-${version}.tgz`;
const APPKIT_UI_TARBALL = `databricks-appkit-ui-${version}.tgz`;

const lakebasePkg = JSON.parse(
  readFileSync(join(ROOT, "packages/lakebase/package.json"), "utf-8"),
) as { version: string };
const lakebaseVersion = lakebasePkg.version;
const LAKEBASE_TARBALL = `databricks-lakebase-${lakebaseVersion}.tgz`;

// 1. Copy template into staging directory
mkdirSync(STAGING_DIR, { recursive: true });
cpSync(join(ROOT, "template"), STAGING_DIR, { recursive: true });
console.log(`✓ Copied template/ → ${outputDir}/`);

// 2. Copy tarballs into staging directory
const appkitSrc = tarballDir
  ? join(ROOT, tarballDir, APPKIT_TARBALL)
  : join(ROOT, "packages/appkit/tmp", APPKIT_TARBALL);
const appkitUiSrc = tarballDir
  ? join(ROOT, tarballDir, APPKIT_UI_TARBALL)
  : join(ROOT, "packages/appkit-ui/tmp", APPKIT_UI_TARBALL);

copyFileSync(appkitSrc, join(STAGING_DIR, APPKIT_TARBALL));
copyFileSync(appkitUiSrc, join(STAGING_DIR, APPKIT_UI_TARBALL));
console.log(`✓ Copied ${APPKIT_TARBALL} and ${APPKIT_UI_TARBALL}`);

const lakebaseSrc = join(ROOT, "packages/lakebase/tmp", LAKEBASE_TARBALL);
if (existsSync(lakebaseSrc)) {
  copyFileSync(lakebaseSrc, join(STAGING_DIR, LAKEBASE_TARBALL));
  console.log(`✓ Copied ${LAKEBASE_TARBALL}`);
}

// 3. Rewrite package.json dependencies to point at the local tarballs
const pkgPath = join(STAGING_DIR, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
pkg.dependencies["@databricks/appkit"] = `file:./${APPKIT_TARBALL}`;
pkg.dependencies["@databricks/appkit-ui"] = `file:./${APPKIT_UI_TARBALL}`;
if (existsSync(lakebaseSrc)) {
  pkg.overrides = pkg.overrides ?? {};
  pkg.overrides["@databricks/lakebase"] = `file:./${LAKEBASE_TARBALL}`;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  existsSync(lakebaseSrc)
    ? "✓ Rewrote package.json (appkit/appkit-ui file: deps; @databricks/lakebase override)"
    : "✓ Rewrote package.json dependencies to file: references (no local lakebase pack)",
);

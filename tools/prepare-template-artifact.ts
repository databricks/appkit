#!/usr/bin/env tsx
/**
 * Prepares a template artifact for testing or release.
 *
 * Copies the template/ directory into a staging folder, bundles the SDK tarballs,
 * and rewrites package.json to use `file:` references for appkit and appkit-ui.
 *
 * When `packages/lakebase/tmp/databricks-lakebase-*.tgz` exists (e.g. after
 * `pnpm pack:sdk` on a dev checkout), that tarball is copied into the staging folder and
 * `overrides["@databricks/lakebase"]` is set so the template install uses the local pack
 * instead of the registry. Release jobs that only download appkit tarballs skip this
 * branch and keep the default semver resolution from the appkit tarball.
 *
 * Usage:
 *   tsx tools/prepare-template-artifact.ts [--tarball-dir <path>] [--output-dir <path>]
 *
 * Options:
 *   --tarball-dir  Optional. Single directory containing both tarballs.
 *                  Defaults to packages/appkit/tmp/ and packages/appkit-ui/tmp/.
 *   --output-dir   Optional. Staging directory name. Defaults to "pr-template".
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = process.cwd();

const { values } = parseArgs({
  options: {
    "tarball-dir": { type: "string" },
    "output-dir": { type: "string", default: "pr-template" },
  },
  strict: true,
});

const tarballDir = values["tarball-dir"];
// biome-ignore lint/style/noNonNullAssertion: default value guarantees this is defined
const outputDir = values["output-dir"]!;

const STAGING_DIR = join(ROOT, outputDir);

function getTarballName(
  dir: string,
  packageName: string,
  required = true,
): string {
  const pattern = new RegExp(
    `^databricks-${packageName}-\\d+\\.\\d+\\.\\d+(?:-pr\\.[0-9a-f]+)?\\.tgz$`,
    "i",
  );
  if (!existsSync(dir)) {
    if (!required) {
      return "";
    }
    console.error(`Expected tarball directory to exist: ${dir}`);
    process.exit(1);
  }
  const matches = readdirSync(dir).filter((entry) => pattern.test(entry));
  if (!required && matches.length === 0) {
    return "";
  }
  if (matches.length !== 1) {
    console.error(
      `Expected exactly one ${pattern.source} tarball in ${dir}, found ${matches.length}`,
    );
    process.exit(1);
  }
  return matches[0];
}

// 1. Copy template into staging directory
mkdirSync(STAGING_DIR, { recursive: true });
cpSync(join(ROOT, "template"), STAGING_DIR, { recursive: true });
console.log(`✓ Copied template/ → ${outputDir}/`);

// 2. Copy tarballs into staging directory
const appkitDir = tarballDir
  ? join(ROOT, tarballDir)
  : join(ROOT, "packages/appkit/tmp");
const appkitUiDir = tarballDir
  ? join(ROOT, tarballDir)
  : join(ROOT, "packages/appkit-ui/tmp");
const lakebaseDir = tarballDir
  ? join(ROOT, tarballDir)
  : join(ROOT, "packages/lakebase/tmp");

const APPKIT_TARBALL = getTarballName(appkitDir, "appkit");
const APPKIT_UI_TARBALL = getTarballName(appkitUiDir, "appkit-ui");
const LAKEBASE_TARBALL = getTarballName(lakebaseDir, "lakebase", false);

const appkitSrc = join(appkitDir, APPKIT_TARBALL);
const appkitUiSrc = join(appkitUiDir, APPKIT_UI_TARBALL);

copyFileSync(appkitSrc, join(STAGING_DIR, APPKIT_TARBALL));
copyFileSync(appkitUiSrc, join(STAGING_DIR, APPKIT_UI_TARBALL));
console.log(`✓ Copied ${APPKIT_TARBALL} and ${APPKIT_UI_TARBALL}`);

const lakebaseSrc = LAKEBASE_TARBALL ? join(lakebaseDir, LAKEBASE_TARBALL) : "";
if (LAKEBASE_TARBALL && lakebaseSrc && existsSync(lakebaseSrc)) {
  copyFileSync(lakebaseSrc, join(STAGING_DIR, LAKEBASE_TARBALL));
  console.log(`✓ Copied ${LAKEBASE_TARBALL}`);
}

// 3. Rewrite package.json dependencies to point at the local tarballs
const pkgPath = join(STAGING_DIR, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
pkg.dependencies["@databricks/appkit"] = `file:./${APPKIT_TARBALL}`;
pkg.dependencies["@databricks/appkit-ui"] = `file:./${APPKIT_UI_TARBALL}`;
if (lakebaseSrc && existsSync(lakebaseSrc) && LAKEBASE_TARBALL) {
  pkg.overrides = pkg.overrides ?? {};
  pkg.overrides["@databricks/lakebase"] = `file:./${LAKEBASE_TARBALL}`;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  lakebaseSrc && existsSync(lakebaseSrc)
    ? "✓ Rewrote package.json (appkit/appkit-ui file: deps; @databricks/lakebase override)"
    : "✓ Rewrote package.json dependencies to file: references (no local lakebase pack)",
);

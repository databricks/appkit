#!/usr/bin/env tsx
/**
 * Applies release changes to the appkit repo: changelog, version bumps,
 * NOTICE copy, then commits and tags. Does NOT push — the caller handles that.
 *
 * Used by the private secure release repo during the finalize step.
 * Changes here affect the release pipeline.
 *
 * Usage: tsx tools/finalize-release.ts <version> <tag> <stream> <artifacts-dir>
 *   version      — semver string, e.g. "0.22.0"
 *   tag          — git tag, e.g. "v0.22.0" or "lakebase-v0.3.0"
 *   stream       — "appkit" or "lakebase"
 *   artifacts-dir — path to the downloaded release artifacts
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const [version, tag, stream, artifactsDir] = process.argv.slice(2);
if (!version || !tag || !stream || !artifactsDir) {
  console.error(
    "Usage: tsx tools/finalize-release.ts <version> <tag> <stream> <artifacts-dir>",
  );
  process.exit(1);
}

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

// 1. Apply changelog diff
const changelogDiff = join(artifactsDir, "changelog-diff.md");
if (existsSync(changelogDiff)) {
  const diff = readFileSync(changelogDiff, "utf-8");
  const changelogPath = join(ROOT, "CHANGELOG.md");

  if (existsSync(changelogPath)) {
    const existing = readFileSync(changelogPath, "utf-8");
    const lines = existing.split("\n");
    // Insert after the header (first 3 lines: title, blank, description)
    const header = lines.slice(0, 3).join("\n");
    const rest = lines.slice(3).join("\n");
    writeFileSync(changelogPath, `${header}\n\n${diff}\n${rest}`);
  } else {
    copyFileSync(changelogDiff, changelogPath);
  }
  console.log("✓ changelog updated");
}

// 2. Bump versions
if (stream === "appkit") {
  // Reuse sync-versions.ts logic for appkit + appkit-ui
  const PACKAGES = ["packages/appkit", "packages/appkit-ui"];
  for (const pkg of PACKAGES) {
    const pkgJsonPath = join(ROOT, pkg, "package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    pkgJson.version = version;
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
    console.log(`✓ ${pkg}/package.json → ${version}`);
  }
} else {
  // Lakebase is a single package
  const pkgJsonPath = join(ROOT, "packages/lakebase/package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  pkgJson.version = version;
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  console.log(`✓ packages/lakebase/package.json → ${version}`);
}

// 3. Copy NOTICE.md if present
const noticeSrc = join(artifactsDir, "NOTICE.md");
if (existsSync(noticeSrc)) {
  copyFileSync(noticeSrc, join(ROOT, "NOTICE.md"));
  console.log("✓ NOTICE.md copied");
}

// 4. Commit and tag (do NOT push)
run("git", ["add", "-A"]);
run("git", ["commit", "-s", "-m", `chore: release ${tag} [skip ci]`]);
run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);

console.log(`✓ committed and tagged ${tag}`);

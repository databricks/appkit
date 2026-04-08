#!/usr/bin/env tsx
/**
 * Dry-run release: shows the next version and changelog preview.
 *
 * Calls release-version.ts and release-changelog.ts programmatically
 * for the main appkit/appkit-ui release stream.
 *
 * Usage:
 *   tsx tools/release-dry.ts
 *   tsx tools/release-dry.ts --lakebase
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const isLakebase = process.argv.includes("--lakebase");

const pathArgs = isLakebase
	? ["--path", "packages/lakebase", "--tag-prefix", "lakebase-v"]
	: [
			"--path",
			"packages/appkit",
			"--path",
			"packages/appkit-ui",
			"--path",
			"packages/shared",
		];

const label = isLakebase ? "@databricks/lakebase" : "AppKit";

// 1. Get version
const versionResult = spawnSync(
	"tsx",
	[join(ROOT, "tools/release-version.ts"), ...pathArgs],
	{ cwd: ROOT, encoding: "utf-8" },
);

if (versionResult.status !== 0) {
	console.log(`No releasable commits found for ${label}.`);
	if (versionResult.stderr) {
		console.error(versionResult.stderr.trim());
	}
	process.exit(0);
}

const version = versionResult.stdout.trim();
console.log(`\n${label} next version: ${version}\n`);
console.log("---");

// 2. Generate changelog preview
const changelogResult = spawnSync(
	"tsx",
	[join(ROOT, "tools/release-changelog.ts"), "--version", version, ...pathArgs],
	{ cwd: ROOT, encoding: "utf-8" },
);

if (changelogResult.status !== 0) {
	console.error("Failed to generate changelog preview:");
	console.error(changelogResult.stderr?.trim());
	process.exit(1);
}

console.log(changelogResult.stdout);

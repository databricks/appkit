#!/usr/bin/env tsx
/**
 * Determines the next release version from conventional commits.
 *
 * Uses the `conventional-recommended-bump` Bumper API with
 * `conventionalcommits` preset and optional path filtering for monorepo
 * support.
 *
 * Usage:
 *   tsx tools/release-version.ts --path packages/appkit --path packages/appkit-ui --path packages/shared
 *   tsx tools/release-version.ts --path packages/lakebase --tag-prefix lakebase-v
 *
 * Prints the next version to stdout.
 * Exit code 0 = bump needed, exit code 1 = no releasable commits.
 */

import { Bumper } from "conventional-recommended-bump";
import { ConventionalGitClient, getSemverTags } from "@conventional-changelog/git-client";
import { inc as semverInc } from "semver";

interface Args {
	paths: string[];
	tagPrefix: string;
}

function parseArgs(): Args {
	const args = process.argv.slice(2);
	const paths: string[] = [];
	let tagPrefix = "v";

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--path" && i + 1 < args.length) {
			paths.push(args[++i]);
		} else if (args[i] === "--tag-prefix" && i + 1 < args.length) {
			tagPrefix = args[++i];
		}
	}

	return { paths, tagPrefix };
}

async function main(): Promise<void> {
	const { paths, tagPrefix } = parseArgs();

	const cwd = process.cwd();
	const gitClient = new ConventionalGitClient(cwd);

	// Get the current version from the latest matching semver tag
	let currentVersion: string | null = null;
	for await (const tag of getSemverTags(gitClient, {
		prefix: tagPrefix,
		skipUnstable: true,
	})) {
		currentVersion = tag;
		break; // getSemverTags yields in descending order, first is latest
	}

	const bumper = new Bumper(gitClient);

	// Configure tag params for finding the last release tag
	bumper.tag({ prefix: tagPrefix });

	// Configure commit params with path filtering for monorepo scoping
	const commitParams: Record<string, unknown> = {};
	if (paths.length > 0) {
		commitParams.path = paths;
	}
	bumper.commits(commitParams as Parameters<typeof bumper.commits>[0]);

	// Load the conventionalcommits preset
	bumper.loadPreset({
		name: "conventionalcommits",
	});

	const result = await bumper.bump();

	if (!result.releaseType) {
		process.stderr.write("No releasable commits found\n");
		process.exit(1);
	}

	const baseVersion = currentVersion ?? "0.0.0";
	const nextVersion = semverInc(baseVersion, result.releaseType);

	if (!nextVersion) {
		process.stderr.write(
			`Failed to compute next version from ${baseVersion} with bump ${result.releaseType}\n`,
		);
		process.exit(1);
	}

	// Print only the version to stdout (for scripting)
	process.stdout.write(`${nextVersion}\n`);
}

main().catch((err) => {
	process.stderr.write(`Error: ${err.message}\n`);
	process.exit(1);
});

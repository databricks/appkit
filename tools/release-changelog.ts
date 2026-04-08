#!/usr/bin/env tsx
/**
 * Generates changelog diff for a given version from conventional commits.
 *
 * Uses the `conventional-changelog` Generator API with `conventionalcommits`
 * preset and optional path filtering for monorepo support.
 *
 * Usage:
 *   tsx tools/release-changelog.ts --version 0.22.0 --path packages/appkit --path packages/appkit-ui --path packages/shared
 *   tsx tools/release-changelog.ts --version 0.3.0 --path packages/lakebase --tag-prefix lakebase-v --output changelog-diff.md
 *
 * Writes changelog diff to stdout or to --output file.
 */

import { writeFileSync } from "node:fs";
import { ConventionalChangelog } from "conventional-changelog";

interface Args {
	version: string;
	paths: string[];
	tagPrefix: string;
	output: string | null;
}

function parseArgs(): Args {
	const args = process.argv.slice(2);
	const paths: string[] = [];
	let tagPrefix = "v";
	let version = "";
	let output: string | null = null;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--version":
				version = args[++i];
				break;
			case "--path":
				paths.push(args[++i]);
				break;
			case "--tag-prefix":
				tagPrefix = args[++i];
				break;
			case "--output":
				output = args[++i];
				break;
		}
	}

	if (!version) {
		process.stderr.write("Error: --version is required\n");
		process.exit(1);
	}

	return { version, paths, tagPrefix, output };
}

async function main(): Promise<void> {
	const { version, paths, tagPrefix, output } = parseArgs();

	const generator = new ConventionalChangelog();

	// Load the conventionalcommits preset
	generator.loadPreset({
		name: "conventionalcommits",
	});

	// Configure tags with prefix for finding the last release
	generator.tags({ prefix: tagPrefix });

	// Configure commit params with path filtering
	const commitParams: Record<string, unknown> = {};
	if (paths.length > 0) {
		commitParams.path = paths;
	}
	generator.commits(commitParams as Parameters<typeof generator.commits>[0]);

	// Set writer options matching the previous release-it config
	generator.writer({
		groupBy: "scope",
		commitGroupsSort: "title",
		commitsSort: ["type", "subject"],
	} as Parameters<typeof generator.writer>[0]);

	// Set the version context so the changelog header uses the right version
	generator.context({ version });

	// Generate only 1 release worth of changelog (the diff)
	generator.options({ releaseCount: 1 });

	// Collect the generated changelog
	let changelog = "";
	for await (const chunk of generator.write()) {
		changelog += chunk;
	}

	if (output) {
		writeFileSync(output, changelog, "utf-8");
		process.stderr.write(`Changelog written to ${output}\n`);
	} else {
		process.stdout.write(changelog);
	}
}

main().catch((err) => {
	process.stderr.write(`Error: ${err.message}\n`);
	process.exit(1);
});

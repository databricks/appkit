#!/usr/bin/env tsx

/**
 * Scans for Conventional Commits breaking-change markers in a PR. Three
 * surfaces are checked, because all three feed `release-it` once the PR is
 * squash-merged:
 *
 *   1. Each commit between $BASE_SHA and $HEAD_SHA, restricted to the
 *      packages tracked by .release-it.json (avoids docs/tooling-only noise).
 *   2. The PR title ($PR_TITLE), which becomes the squash commit subject.
 *   3. The PR description ($PR_BODY), which can land in the squash commit
 *      body depending on repo settings.
 *
 * Writes `found` and (on match) `list` to $GITHUB_OUTPUT. The `list` is a
 * markdown bullet list, grouping hits by source surface.
 *
 * Required env: BASE_SHA, HEAD_SHA, GITHUB_OUTPUT
 * Optional env: PR_TITLE, PR_BODY
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const TRACKED_PATHS = [
  "packages/appkit",
  "packages/appkit-ui",
  "packages/shared",
];

// Conventional Commits breaking-change markers:
//   1. `type!:` or `type(scope)!:` in the subject line
//   2. `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer line
const BREAKING_PATTERN =
  /^(feat|fix|chore|refactor|perf|build|ci|docs|style|test|revert)(\([^)]+\))?!:|^BREAKING[ -]CHANGE:/m;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function listCommits(base: string, head: string): string[] {
  return git("rev-list", `${base}..${head}`, "--", ...TRACKED_PATHS)
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean);
}

function commitMessage(sha: string): string {
  return git("log", "-1", "--format=%B", sha);
}

function commitSubject(sha: string): string {
  return git("log", "-1", "--format=%s", sha).trim();
}

function scanCommits(base: string, head: string): string[] {
  const hits: string[] = [];
  for (const sha of listCommits(base, head)) {
    if (BREAKING_PATTERN.test(commitMessage(sha))) {
      hits.push(`  - \`${sha.slice(0, 7)}\` ${commitSubject(sha)}`);
    }
  }
  return hits;
}

function scanText(text: string | undefined): boolean {
  return Boolean(text && BREAKING_PATTERN.test(text));
}

function writeOutput(found: boolean, list: string): void {
  const outputPath = requireEnv("GITHUB_OUTPUT");
  if (!found) {
    appendFileSync(outputPath, "found=false\n");
    return;
  }
  appendFileSync(
    outputPath,
    `found=true\nlist<<COMMITS_EOF\n${list}\nCOMMITS_EOF\n`,
  );
}

function main(): void {
  const base = requireEnv("BASE_SHA");
  const head = requireEnv("HEAD_SHA");
  const prTitle = process.env.PR_TITLE;
  const prBody = process.env.PR_BODY;

  const sections: string[] = [];

  if (scanText(prTitle)) {
    sections.push(`- **PR title**: \`${prTitle?.trim()}\``);
  }

  if (scanText(prBody)) {
    sections.push("- **PR description** contains a breaking-change marker.");
  }

  const commitHits = scanCommits(base, head);
  if (commitHits.length > 0) {
    sections.push(["- **Commits**:", ...commitHits].join("\n"));
  }

  if (sections.length === 0) {
    console.log("No breaking-change markers found.");
    writeOutput(false, "");
    return;
  }

  const list = sections.join("\n");
  console.log("Breaking-change markers found:");
  console.log(list);
  writeOutput(true, list);
}

main();

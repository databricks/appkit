#!/usr/bin/env tsx

/**
 * Scans commits between $BASE_SHA and $HEAD_SHA for Conventional Commits
 * breaking-change markers, restricted to the packages tracked by
 * .release-it.json. Writes `found` and (on match) `list` to $GITHUB_OUTPUT.
 *
 * Required env: BASE_SHA, HEAD_SHA, GITHUB_OUTPUT
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

function writeOutput(found: boolean, list: string): void {
  const outputPath = requireEnv("GITHUB_OUTPUT");
  if (!found) {
    appendFileSync(outputPath, "found=false\n");
    return;
  }
  appendFileSync(
    outputPath,
    `found=true\nlist<<COMMITS_EOF\n${list}COMMITS_EOF\n`,
  );
}

function main(): void {
  const base = requireEnv("BASE_SHA");
  const head = requireEnv("HEAD_SHA");

  const breaking: string[] = [];
  for (const sha of listCommits(base, head)) {
    if (BREAKING_PATTERN.test(commitMessage(sha))) {
      breaking.push(`- \`${sha.slice(0, 7)}\` ${commitSubject(sha)}\n`);
    }
  }

  if (breaking.length === 0) {
    console.log("No breaking commits found.");
    writeOutput(false, "");
    return;
  }

  const list = breaking.join("");
  console.log("Breaking commits found:");
  process.stdout.write(list);
  writeOutput(true, list);
}

main();

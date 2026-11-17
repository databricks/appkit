#!/usr/bin/env tsx
/**
 * Syncs the template to the given version (with retry), then commits, tags
 * template-vX.X.X, and pushes.
 *
 * Used by the private secure release repo during the template-sync step.
 * Changes here affect the release pipeline.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const version = process.argv[2];
if (!version) {
  console.error("Usage: tsx tools/publish-template-tag.ts <version>");
  process.exit(1);
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): number {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    stdio: "inherit",
  });
  return result.status ?? 1;
}

// 1. Update template package.json
const templatePath = join(ROOT, "template", "package.json");
const templateJson = JSON.parse(readFileSync(templatePath, "utf-8"));
if (templateJson.dependencies) {
  if ("@databricks/appkit" in templateJson.dependencies) {
    templateJson.dependencies["@databricks/appkit"] = version;
  }
  if ("@databricks/appkit-ui" in templateJson.dependencies) {
    templateJson.dependencies["@databricks/appkit-ui"] = version;
  }
  writeFileSync(templatePath, `${JSON.stringify(templateJson, null, 2)}\n`);
  console.log(`✓ template/package.json → ${version}`);
}

// 2. Regenerate both lockfiles in template (the template ships both; retry
// for registry propagation of the just-published version).
const MAX_ATTEMPTS = 3;
const templateDir = join(ROOT, "template");
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInstallWithRetry(
  label: string,
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<number> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const status = run(cmd, args, { cwd: templateDir, env });
    lastStatus = status;
    if (status === 0) {
      return 0;
    }
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = 2 ** attempt * 1000;
      console.warn(
        `${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delayMs / 1000}s...`,
      );
      await sleep(delayMs);
    }
  }
  return lastStatus;
}

// Matches CI's registry cooldown; newer versions 403 in template jobs.
const RELEASE_AGE_DAYS = 7;
const RELEASE_AGE_EXCLUDE = "@databricks/*";

// npm ignores unknown config keys, which would silently drop the cooldown.
const npmConfig = spawnSync(
  "npm",
  ["config", "get", "min-release-age-exclude"],
  {
    cwd: templateDir,
    encoding: "utf-8",
  },
);
if (npmConfig.status !== 0 || npmConfig.stdout.trim() === "undefined") {
  console.error(
    "npm does not support min-release-age-exclude; upgrade npm (11.19+ works).",
  );
  process.exit(1);
}

// 2a. npm → package-lock.json
const npmExit = await runInstallWithRetry("npm install", "npm", [
  "install",
  `--min-release-age=${RELEASE_AGE_DAYS}`,
  `--min-release-age-exclude=${RELEASE_AGE_EXCLUDE}`,
]);
if (npmExit !== 0) {
  console.error(`npm install failed after ${MAX_ATTEMPTS} attempts`);
  process.exit(npmExit);
}
console.log("✓ template/package-lock.json updated (npm install)");

// 11.1.2+ fixes minimumReleaseAge on public npm: https://github.com/pnpm/pnpm/issues/11619
const PNPM = ["--yes", "pnpm@11.1.2"];

// 2b. pnpm preflight — fail loud rather than silently skip the pnpm lock.
if (run("npx", [...PNPM, "--version"]) !== 0) {
  console.error(
    "pnpm is not invokable — cannot regenerate template/pnpm-lock.yaml. " +
      "Ensure the release runner's pnpm setup ran before this script.",
  );
  process.exit(1);
}

// 2c. pnpm → pnpm-lock.yaml (--no-frozen-lockfile: pnpm defaults to frozen
// under CI; --lockfile-only: skip the node_modules rebuild).
// pnpm ignores minimumReleaseAge CLI flags; the exclude env var must be a JSON array.
const pnpmExit = await runInstallWithRetry(
  "pnpm install",
  "npx",
  [...PNPM, "install", "--lockfile-only", "--no-frozen-lockfile"],
  {
    // Don't switch to the template's packageManager pin.
    pnpm_config_pm_on_fail: "ignore",
    pnpm_config_minimum_release_age: String(RELEASE_AGE_DAYS * 24 * 60),
    pnpm_config_minimum_release_age_exclude: JSON.stringify([
      RELEASE_AGE_EXCLUDE,
    ]),
  },
);
if (pnpmExit !== 0) {
  console.error(`pnpm install failed after ${MAX_ATTEMPTS} attempts`);
  process.exit(pnpmExit);
}
console.log("✓ template/pnpm-lock.yaml updated (pnpm install)");

// 3. Git add, commit, tag, push
const commands: [string, string[]][] = [
  [
    "git",
    [
      "add",
      "template/package.json",
      "template/package-lock.json",
      "template/pnpm-lock.yaml",
    ],
  ],
  [
    "git",
    ["commit", "-s", "-m", `chore: sync template to v${version} [skip ci]`],
  ],
  ["git", ["tag", "-a", `template-v${version}`, "-m", `Template v${version}`]],
  ["git", ["push", "origin", "HEAD", "--follow-tags"]],
];

for (const [command, args] of commands) {
  if (run(command, args) !== 0) {
    process.exit(1);
  }
}

console.log(`✓ template tag template-v${version} pushed`);

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

import { verifyLockVersions } from "./check-template-lock-versions";

const ROOT = process.cwd();
const version = process.argv[2];
if (!version) {
  console.error("Usage: tsx tools/publish-template-tag.ts <version>");
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): number {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
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
): Promise<number> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const status = run(cmd, args, { cwd: templateDir });
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

// 2a. npm → package-lock.json
const npmExit = await runInstallWithRetry("npm install", "npm", ["install"]);
if (npmExit !== 0) {
  console.error(`npm install failed after ${MAX_ATTEMPTS} attempts`);
  process.exit(npmExit);
}
console.log("✓ template/package-lock.json updated (npm install)");

// 2b. pnpm preflight — fail loud rather than silently skip the pnpm lock.
if (run("pnpm", ["--version"]) !== 0) {
  console.error(
    "pnpm is not invokable — cannot regenerate template/pnpm-lock.yaml. " +
      "Ensure the release runner's pnpm setup ran before this script.",
  );
  process.exit(1);
}

// 2c. pnpm → pnpm-lock.yaml (--no-frozen-lockfile: pnpm defaults to frozen
// under CI; --lockfile-only: skip the node_modules rebuild).
const pnpmExit = await runInstallWithRetry("pnpm install", "pnpm", [
  "install",
  "--lockfile-only",
  "--no-frozen-lockfile",
]);
if (pnpmExit !== 0) {
  console.error(`pnpm install failed after ${MAX_ATTEMPTS} attempts`);
  process.exit(pnpmExit);
}
console.log("✓ template/pnpm-lock.yaml updated (pnpm install)");

// 2d. Guard: both regenerated locks must resolve @databricks/* to the just-set
// version. A stale lock here is the Phase-1 regression — abort, don't commit.
const templateLocks = [
  join(ROOT, "template", "package-lock.json"),
  join(ROOT, "template", "pnpm-lock.yaml"),
];
const { ok, mismatches } = verifyLockVersions(templateLocks, {
  "@databricks/appkit": version,
  "@databricks/appkit-ui": version,
});
if (!ok) {
  for (const m of mismatches) {
    console.error(
      `Lock version mismatch in ${m.lockfile}: "${m.package}" resolves to ` +
        `${m.found ?? "<missing>"} (expected ${m.expected}).`,
    );
  }
  console.error(
    "Aborting release: regenerated locks disagree with the version.",
  );
  process.exit(1);
}
console.log(
  "✓ both template locks resolve @databricks/* to the published version",
);

// 2e. Guard: both committed locks must resolve to the PUBLIC npm registry.
// Fail-closed (no --rewrite): a JFrog/internal URL on this path means the
// environment is wrong and the release must abort, not silently rewrite.
for (const lock of ["template/package-lock.json", "template/pnpm-lock.yaml"]) {
  if (
    run("pnpm", [
      "exec",
      "tsx",
      "tools/check-template-lock-registry.ts",
      lock,
      "--allow-file",
    ]) !== 0
  ) {
    console.error(
      `Aborting release: ${lock} references a non-public registry.`,
    );
    process.exit(1);
  }
}

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

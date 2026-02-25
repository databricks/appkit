#!/usr/bin/env tsx
/**
 * Syncs the template to the given version (with retry), then commits, tags
 * template-vX.X.X, and pushes. Used by the Release workflow (sync-template job
 * in .github/workflows/release.yml) and for manual runs.
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

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): number {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
    shell: true,
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

// 2. npm install in template (with retry for registry propagation)
const MAX_ATTEMPTS = 3;
const templateDir = join(ROOT, "template");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runNpmInstallWithRetry(): Promise<number> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const status = run("npm", ["install"], { cwd: templateDir });
    lastStatus = status;
    if (status === 0) {
      console.log("✓ template/package-lock.json updated (npm install)");
      return 0;
    }
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = 2 ** attempt * 1000;
      console.warn(
        `npm install failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delayMs / 1000}s...`,
      );
      await sleep(delayMs);
    }
  }
  return lastStatus;
}

const installExit = await runNpmInstallWithRetry();
if (installExit !== 0) {
  console.error(`npm install failed after ${MAX_ATTEMPTS} attempts`);
  process.exit(installExit);
}

// 3. Git add, commit, tag, push
const commands: [string, string[]][] = [
  ["git", ["add", "template/package.json", "template/package-lock.json"]],
  ["git", ["commit", "-m", `"chore: sync template to v${version} [skip ci]"`]],
  ["git", ["tag", "-a", `template-v${version}`, "-m", `Template v${version}`]],
  ["git", ["push", "origin", "main", "--follow-tags"]],
];

for (const [command, args] of commands) {
  if (run(command, args) !== 0) {
    process.exit(1);
  }
}

console.log(`✓ template tag template-v${version} pushed`);

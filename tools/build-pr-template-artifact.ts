#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TEMPLATE_DIR = path.join(ROOT, "template");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "artifacts", "pr-template");
const APPKIT_PACKAGE_NAME = "@databricks/appkit";
const APPKIT_UI_PACKAGE_NAME = "@databricks/appkit-ui";

type ParsedArgs = {
  branch?: string;
  outputDir: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  let branch: string | undefined;
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--") {
      continue;
    }

    if (arg === "--branch") {
      if (!value) {
        throw new Error("Missing value for --branch");
      }
      branch = value;
      index += 1;
      continue;
    }

    if (arg === "--output-dir") {
      if (!value) {
        throw new Error("Missing value for --output-dir");
      }
      outputDir = path.resolve(ROOT, value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { branch, outputDir };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveBranchName(branchArg?: string) {
  const branchName =
    branchArg ??
    process.env.GITHUB_HEAD_REF ??
    process.env.GITHUB_REF_NAME ??
    process.env.BRANCH_NAME;

  if (!branchName) {
    throw new Error(
      "Unable to determine branch name. Pass --branch or set GITHUB_HEAD_REF.",
    );
  }

  return branchName;
}

function sanitizeBranchName(branchName: string) {
  const sanitized = branchName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);

  return sanitized || "branch";
}

function ensureExists(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected file does not exist: ${filePath}`);
  }
}

function main() {
  const { branch, outputDir } = parseArgs(process.argv.slice(2));
  const branchName = resolveBranchName(branch);
  const appkitPackageJsonPath = path.join(
    ROOT,
    "packages",
    "appkit",
    "package.json",
  );
  const appkitPackageJson = readJson<{ version: string }>(
    appkitPackageJsonPath,
  );
  const prVersion = `v${appkitPackageJson.version}-${sanitizeBranchName(branchName)}`;

  console.log(`Building PR template artifact for version ${prVersion}`);

  run("pnpm", ["pack:sdk"], {
    env: {
      ...process.env,
      APPKIT_PACKAGE_VERSION_OVERRIDE: prVersion,
    },
  });

  const appkitTarball = path.join(
    ROOT,
    "packages",
    "appkit",
    "tmp",
    `databricks-appkit-${prVersion}.tgz`,
  );
  const appkitUiTarball = path.join(
    ROOT,
    "packages",
    "appkit-ui",
    "tmp",
    `databricks-appkit-ui-${prVersion}.tgz`,
  );
  const stagedTemplateDir = path.join(outputDir, "template");

  ensureExists(appkitTarball);
  ensureExists(appkitUiTarball);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(TEMPLATE_DIR, stagedTemplateDir, { recursive: true });
  fs.copyFileSync(
    appkitTarball,
    path.join(stagedTemplateDir, path.basename(appkitTarball)),
  );
  fs.copyFileSync(
    appkitUiTarball,
    path.join(stagedTemplateDir, path.basename(appkitUiTarball)),
  );

  const templatePackageJsonPath = path.join(stagedTemplateDir, "package.json");
  const templatePackageJson = readJson<{
    dependencies?: Record<string, string>;
  }>(templatePackageJsonPath);

  if (!templatePackageJson.dependencies) {
    throw new Error("template/package.json is missing dependencies");
  }

  templatePackageJson.dependencies[APPKIT_PACKAGE_NAME] =
    `file:./${path.basename(appkitTarball)}`;
  templatePackageJson.dependencies[APPKIT_UI_PACKAGE_NAME] =
    `file:./${path.basename(appkitUiTarball)}`;
  writeJson(templatePackageJsonPath, templatePackageJson);

  run("npm", ["install"], { cwd: stagedTemplateDir });
  fs.rmSync(path.join(stagedTemplateDir, "node_modules"), {
    recursive: true,
    force: true,
  });

  console.log(`PR template artifact ready at ${stagedTemplateDir}`);
}

main();

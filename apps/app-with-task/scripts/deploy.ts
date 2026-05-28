#!/usr/bin/env tsx
/**
 * Deploy app-with-task to Databricks Apps.
 *
 * Mirrors the strategy used by `pnpm deploy:playground`:
 *
 *   1. `pnpm pack:sdk` (workspace root) → produces `.tgz` for
 *      `@databricks/appkit` and `@databricks/appkit-ui`.
 *   2. Copy `apps/app-with-task` to `deployable-app-with-task/`.
 *   3. Rewrite `package.json` so `workspace:*` deps become
 *      `file:./<tarball>.tgz` references the platform's `npm install`
 *      can resolve.
 *   4. Copy the tarballs into the deployable directory.
 *   5. Swap `vite.config.ts` for the deploy-safe version (no monorepo
 *      path aliases).
 *   6. `pnpm build` inside deployable so `dist/` is included in the
 *      upload (server.ts serves it statically in production).
 *   7. `databricks sync` the deployable to the workspace, then
 *      `databricks apps deploy`.
 *
 * Environment:
 *   DATABRICKS_PROFILE         CLI profile (e.g. "DEFAULT")
 *   DATABRICKS_APP_NAME        App name (defaults to "<user>-app-with-task")
 *   DATABRICKS_WORKSPACE_DIR   Workspace dir (defaults to app name)
 */
import { exec as execChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execChildProcess);

// scripts/deploy.ts → app-with-task/ → apps/ → appkit/  (the workspace root)
const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
);
const APP_FOLDER = path.join(REPO_ROOT, "apps", "app-with-task");
const TMP_FOLDER = path.join(REPO_ROOT, "deployable-app-with-task");
const PREPARED_VITE = path.join(
  APP_FOLDER,
  "scripts",
  "prepared",
  "vite.config.ts",
);

const config = {
  profile: process.env.DATABRICKS_PROFILE,
  appName: process.env.DATABRICKS_APP_NAME,
  workspaceDir: process.env.DATABRICKS_WORKSPACE_DIR,
};

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

async function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

// Build a per-deploy tarball that pins a unique version.
//
// Why: the Apps platform runs `npm install` on each deploy with
// `prefer-offline=true` and a cached node_modules from the previous
// deploy. When the deployable's `package.json` references the same
// `file:./databricks-appkit-<ver>.tgz` and the inner package.json
// reports the same `version`, npm short-circuits ("up to date in 774ms")
// and the new tarball's contents are never extracted — so a fresh
// taskflow native binary inside the tarball is ignored and the old
// node_modules tree keeps running. Tagging the version per-deploy makes
// every install look like a real version change.
async function buildTaggedTarball(
  packageDir: string,
  pkgName: string,
  baseVersion: string,
  deployTag: string,
): Promise<{ tarball: string; version: string }> {
  const taggedVersion = `${baseVersion}-deploy.${deployTag}`;
  const tmpDir = path.join(packageDir, "tmp");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  await run("pnpm", ["dist"], packageDir);

  const tmpPkgPath = path.join(tmpDir, "package.json");
  const tmpPkg = readJson(tmpPkgPath) as { version: string };
  tmpPkg.version = taggedVersion;
  writeJson(tmpPkgPath, tmpPkg);

  await run(
    "npm",
    ["pack", "./tmp", "--pack-destination", "./tmp"],
    packageDir,
  );

  const slug = pkgName.replace(/^@/, "").replace("/", "-");
  const tarball = path.join(tmpDir, `${slug}-${taggedVersion}.tgz`);
  if (!fs.existsSync(tarball)) {
    throw new Error(`Expected tarball not found: ${tarball}`);
  }
  return { tarball, version: taggedVersion };
}

async function deploy() {
  console.log("──── build + pack appkit + appkit-ui ────");
  // Keep this surgical: build only the two packages the app imports.
  // `pnpm pack:sdk` from the root would also build docs (Docusaurus)
  // and package the whole workspace, which is expensive and unnecessary
  // for an app deploy.
  await run(
    "pnpm",
    [
      "--filter=@databricks/appkit",
      "--filter=@databricks/appkit-ui",
      "build:package",
    ],
    REPO_ROOT,
  );

  const deployTag = Date.now().toString();
  const baseAppkitVersion = (
    readJson(path.join(REPO_ROOT, "packages", "appkit", "package.json")) as {
      version: string;
    }
  ).version;
  const baseAppkitUiVersion = (
    readJson(path.join(REPO_ROOT, "packages", "appkit-ui", "package.json")) as {
      version: string;
    }
  ).version;

  const appkitBuild = await buildTaggedTarball(
    path.join(REPO_ROOT, "packages", "appkit"),
    "@databricks/appkit",
    baseAppkitVersion,
    deployTag,
  );
  const appkitUiBuild = await buildTaggedTarball(
    path.join(REPO_ROOT, "packages", "appkit-ui"),
    "@databricks/appkit-ui",
    baseAppkitUiVersion,
    deployTag,
  );
  const appkitTarball = appkitBuild.tarball;
  const appkitUiTarball = appkitUiBuild.tarball;
  const appkitVersion = appkitBuild.version;
  const appkitUiVersion = appkitUiBuild.version;

  console.log("──── stage deployable ────");
  if (fs.existsSync(TMP_FOLDER)) {
    // Preserve `.databricks` between runs so `apps deploy` stays linked.
    const databricksLink = path.join(TMP_FOLDER, ".databricks");
    if (fs.existsSync(databricksLink)) {
      fs.cpSync(databricksLink, path.join(APP_FOLDER, ".databricks"), {
        recursive: true,
      });
    }
    fs.rmSync(TMP_FOLDER, { recursive: true });
  }
  fs.cpSync(APP_FOLDER, TMP_FOLDER, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(APP_FOLDER, src);
      return (
        !rel.startsWith("node_modules") &&
        !rel.startsWith("dist") &&
        !rel.startsWith(".appkit") &&
        !rel.startsWith("build")
      );
    },
  });

  console.log("──── rewrite package.json (workspace → file:) ────");
  const pkgPath = path.join(TMP_FOLDER, "package.json");
  const pkg = readJson(pkgPath) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  pkg.dependencies = {
    ...(pkg.dependencies ?? {}),
    "@databricks/appkit": `file:./databricks-appkit-${appkitVersion}.tgz`,
    "@databricks/appkit-ui": `file:./databricks-appkit-ui-${appkitUiVersion}.tgz`,
  };
  writeJson(pkgPath, pkg);

  fs.copyFileSync(
    appkitTarball,
    path.join(TMP_FOLDER, `databricks-appkit-${appkitVersion}.tgz`),
  );
  fs.copyFileSync(
    appkitUiTarball,
    path.join(TMP_FOLDER, `databricks-appkit-ui-${appkitUiVersion}.tgz`),
  );

  console.log("──── swap vite.config.ts (deploy-safe) ────");
  fs.copyFileSync(PREPARED_VITE, path.join(TMP_FOLDER, "vite.config.ts"));

  console.log("──── npm install + build (deployable) ────");
  // npm (not pnpm) so `file:./*.tgz` references resolve into a flat
  // node_modules the Apps runtime understands.
  await run("npm", ["install", "--no-audit", "--no-fund"], TMP_FOLDER);
  await run("npm", ["run", "build"], TMP_FOLDER);

  console.log("──── prep upload (drop node_modules + lock, expose dist) ────");
  // Apps re-runs `npm install` on the upload. We don't want our local
  // node_modules going up (sync would skip it via .gitignore anyway,
  // but be explicit). The lockfile is dropped because npm replaying an
  // arm64/darwin-resolved tree on the Linux Apps container has been
  // observed to ENOTEMPTY on package renames — letting Apps resolve
  // fresh against `package.json` is more robust. `dist/` IS uploaded
  // (pre-built here) so the server can serve it statically without
  // needing vite at runtime.
  fs.rmSync(path.join(TMP_FOLDER, "node_modules"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(TMP_FOLDER, "package-lock.json"), { force: true });
  // Override .gitignore in the staged folder so the sync uploads
  // `dist/` (the workspace .gitignore ignores it for dev hygiene).
  fs.writeFileSync(
    path.join(TMP_FOLDER, ".gitignore"),
    ["node_modules", ".appkit", ".env", ".env.local", "*.log", ""].join("\n"),
  );

  // `.npmrc` tuned for the Databricks Apps runtime. The default npm
  // there has been observed to ENOTEMPTY on concurrent package
  // renames (e.g. `@opentelemetry/sdk-trace-base`,
  // `baseline-browser-mapping`). Serial install + offline-prefer +
  // legacy peer deps avoid the race without changing dependencies.
  fs.writeFileSync(
    path.join(TMP_FOLDER, ".npmrc"),
    [
      "prefer-offline=true",
      "maxsockets=1",
      "legacy-peer-deps=true",
      "fund=false",
      "audit=false",
      "",
    ].join("\n"),
  );

  const username = os.userInfo().username;
  const appName =
    config.appName ?? `${username.replace(/\./g, "-")}-app-with-task`;
  const workspaceDir = config.workspaceDir ?? appName;
  const workspacePath = `/Workspace/Users/${username}@databricks.com/${workspaceDir}`;
  const profileArgs = config.profile ? ["-p", config.profile] : [];

  console.log(`──── ensure app exists: ${appName} ────`);
  try {
    await exec(
      `databricks apps get ${appName}${
        profileArgs.length ? ` ${profileArgs.join(" ")}` : ""
      }`,
    );
  } catch {
    console.log(
      `App "${appName}" does not exist. Creating — bind resources (sql-warehouse, database) in the UI afterwards.`,
    );
    await run("databricks", ["apps", "create", appName, ...profileArgs]);
  }

  console.log(`──── databricks sync → ${workspacePath} ────`);
  await run(
    "databricks",
    ["sync", ".", workspacePath, ...profileArgs],
    TMP_FOLDER,
  );

  console.log(`──── databricks apps deploy ${appName} ────`);
  await run("databricks", [
    "apps",
    "deploy",
    appName,
    "--source-code-path",
    workspacePath,
    ...profileArgs,
  ]);

  console.log(`✅ Deployed ${appName}`);
  console.log(
    `   Open the app URL from Databricks Apps UI to verify. Remember to bind:`,
  );
  console.log(`     • sql-warehouse → a SQL Warehouse`);
  console.log(
    `     • database → projects/ditadi-taskflow/branches/appkit/endpoints/primary`,
  );
}

deploy().catch((err) => {
  console.error(err);
  process.exit(1);
});

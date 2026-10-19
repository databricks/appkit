/**
 * End-to-end check that a built tarball's bundled patched dependencies survive
 * a real consumer install, with both npm and pnpm.
 *
 * Usage (after `pnpm tarball` / `pnpm tarball:prerelease`):
 *   tsx tools/verify-bundled-patches.ts packages/appkit [packages/appkit-ui ...]
 *
 * For each package it installs `<dir>/tmp/*.tgz` into a scratch project and,
 * from the installed package's real directory, asserts every
 * `bundledDependencies` entry resolves to the bundled (patched) copy and that
 * each of that copy's dependencies resolves too.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findInstalledPackage, hashPackageDir } from "./bundle-patched-deps";

const packageDirs = process.argv.slice(2);
if (packageDirs.length === 0) {
  console.error("usage: verify-bundled-patches.ts <package-dir> [...]");
  process.exit(2);
}

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error(`  ✗ ${message}`);
};

for (const packageDir of packageDirs) {
  const tmpDir = path.resolve(packageDir, "tmp");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"),
  );
  const bundled: string[] = manifest.bundledDependencies ?? [];
  const tarball = fs.readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error(`no tarball in ${tmpDir}; build it first`);
  console.log(
    `${manifest.name} (${tarball}): bundled ${bundled.join(", ") || "none"}`,
  );
  if (bundled.length === 0) continue;

  for (const pm of ["npm", "pnpm"] as const) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `verify-${pm}-`));
    try {
      fs.writeFileSync(
        path.join(scratch, "package.json"),
        JSON.stringify({
          name: "verify-consumer",
          private: true,
          dependencies: {
            [manifest.name]: `file:${path.join(tmpDir, tarball)}`,
          },
        }),
      );
      execFileSync(pm, ["install", "--ignore-scripts"], {
        cwd: scratch,
        stdio: "ignore",
      });
      const installedDir = fs.realpathSync(
        path.join(scratch, "node_modules", manifest.name),
      );
      for (const name of bundled) {
        const resolved = findInstalledPackage(installedDir, name);
        if (!resolved) {
          fail(`${pm}: ${name} does not resolve from ${manifest.name}`);
          continue;
        }
        const expected = hashPackageDir(
          path.join(tmpDir, "node_modules", name),
        );
        if (hashPackageDir(resolved.dir) !== expected) {
          fail(
            `${pm}: ${name} resolves to an unpatched copy (${resolved.dir})`,
          );
          continue;
        }
        for (const dep of Object.keys(resolved.dependencies)) {
          if (!findInstalledPackage(resolved.dir, dep)) {
            fail(`${pm}: ${name}'s dependency ${dep} does not resolve`);
          }
        }
        console.log(`  ✓ ${pm}: ${name} resolves to the bundled patched copy`);
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (failures > 0) {
  console.error(`${failures} bundled-patch check(s) failed`);
  process.exit(1);
}

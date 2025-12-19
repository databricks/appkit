#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Package = {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage: string;
};

type PackageJson = {
  dependencies?: Record<string, string>;
};

// Packages whose direct dependencies we want to include in NOTICE.md
const PUBLISHED_PACKAGES = [
  "packages/appkit",
  "packages/appkit-ui",
  "packages/shared",
];

function getDirectDependencies(): Set<string> {
  const directDeps = new Set<string>();

  for (const pkgPath of PUBLISHED_PACKAGES) {
    const pkgJsonPath = join(process.cwd(), pkgPath, "package.json");
    try {
      const content = readFileSync(pkgJsonPath, "utf8");
      const pkgJson: PackageJson = JSON.parse(content);

      if (pkgJson.dependencies) {
        for (const depName of Object.keys(pkgJson.dependencies)) {
          if (!pkgJson.dependencies[depName].startsWith("workspace:")) {
            directDeps.add(depName);
          }
        }
      }
    } catch (err) {
      console.error(`Warning: Could not read ${pkgJsonPath}:`, err);
    }
  }

  return directDeps;
}

try {
  const output = execSync("pnpm licenses list --json --production", {
    encoding: "utf8",
  });
  const licenses: Record<string, Package[]> = JSON.parse(output);
  const directDeps = getDirectDependencies();

  const dependencies: Package[] = [];

  for (const [licenseName, packages] of Object.entries(licenses)) {
    for (const pkg of packages) {
      // Only include direct dependencies
      if (directDeps.has(pkg.name)) {
        dependencies.push({ ...pkg, license: licenseName });
      }
    }
  }

  main(dependencies);
} catch (err) {
  console.error("❌ Error running license check:", err);
  process.exit(1);
}

function main(packages: Package[]) {
  const header = `Copyright (2022) Databricks, Inc.

This Software includes software developed at Databricks (https://www.databricks.com/) and its use is subject to the included LICENSE file.
***
This Software contains code from the following open source projects:

`;
  let notice =
    header +
    `| Name             | Installed version | License | Code                                                 |
| :--------------- | :---------------- | :----------- | :--------------------------------------------------- |\n`;

  const deps: Record<string, Package> = {};
  for (const dep of packages) {
    deps[`${dep.name}"@"${dep.versions.join(", ")}`] = dep;
  }
  const depNames = Object.keys(deps).sort();

  for (const depName of depNames) {
    const dep = deps[depName];
    if (dep.name.startsWith("@databricks")) {
      continue;
    }
    notice += `| [${dep.name}](https://www.npmjs.com/package/${
      dep.name
    }) | ${dep.versions.join(", ")} | ${dep.license} | ${dep.homepage} |\n`;
  }
  // eslint-disable-next-line no-console
  console.log(notice);
}

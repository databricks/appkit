#!/usr/bin/env node
import { execSync } from "node:child_process";

type Package = {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage: string;
};

try {
  const output = execSync("pnpm licenses list --json --production", {
    encoding: "utf8",
  });
  const licenses: Record<string, Package[]> = JSON.parse(output);

  const dependencies = [];

  for (const [licenseName, packages] of Object.entries(licenses)) {
    for (const pkg of packages) {
      dependencies.push({ ...pkg, license: licenseName });
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

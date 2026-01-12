#!/usr/bin/env node
import { type Package, getDirectDependencyLicenses } from "./license-utils";

try {
  const packages = getDirectDependencyLicenses();
  main(packages);
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
    }) | ${dep.versions.join(", ")} | ${dep.license} | ${dep.homepage ?? ""} |\n`;
  }
  // eslint-disable-next-line no-console
  console.log(notice);
}

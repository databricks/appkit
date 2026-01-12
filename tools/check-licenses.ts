#!/usr/bin/env node
import { type Package, getDirectDependencyLicenses } from "./license-utils";

const allowedLicenses = new Set([
  "MIT",
  "MIT/X11",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "0BSD",
  "(Public Domain OR MIT)",
  "(MIT OR CC0-1.0)",
  "(BSD-3-Clause OR GPL-2.0)", // in case of such dual licensing, we use BSD-3-Clause
  "MPL-2.0",
]);

const disallowedPatterns = [
  /AGPL/i,
  /GPL/i,
  /SSPL/i,
  /BUSL/i,
  /Elastic/i,
  /Proprietary/i,
  /SEE LICEN[CS]E/i,
];

try {
  const packages = getDirectDependencyLicenses();

  const violations: Package[] = [];

  for (const pkg of packages) {
    if (allowedLicenses.has(pkg.license)) continue;

    const isDisallowed = disallowedPatterns.some((rx) => rx.test(pkg.license));
    if (!isDisallowed) continue;

    violations.push(pkg);
  }

  if (violations.length > 0) {
    console.error("🚫 Disallowed licenses found:\n");
    for (const v of violations) {
      console.error(` ${v.name}@${v.versions.join(", ")} (${v.license})`);
      console.error(` ${v.paths.join("\n - ")}\n`);
      console.error(` --------------------------------\n`);
    }
    process.exit(1);
  } else {
    console.log("✅ All licenses are compliant.");
  }
} catch (err) {
  console.error("❌ Error running license check:", err);
  process.exit(1);
}

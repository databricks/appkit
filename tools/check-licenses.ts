#!/usr/bin/env node
import { execSync } from "node:child_process";

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

type Package = {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
};

try {
  const output = execSync("pnpm licenses list --json", { encoding: "utf8" });
  const licenses: Record<string, Package[]> = JSON.parse(output);

  const violations = [];

  for (const [licenseName, packages] of Object.entries(licenses)) {
    if (allowedLicenses.has(licenseName)) continue;

    const isDisallowed = disallowedPatterns.some((rx) => rx.test(licenseName));
    if (!isDisallowed) continue;

    for (const pkg of packages) {
      violations.push({ ...pkg, license: licenseName });
    }
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

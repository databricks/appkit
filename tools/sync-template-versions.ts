#!/usr/bin/env tsx

/**
 * Updates the template to the given SDK version and runs npm install so
 * package-lock.json has correct integrity. Run after publishing to npm (e.g.
 * in release-it after:release); then commit, tag template-vX.X.X, and push.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const version = process.argv[2];
if (!version) {
  console.error("Usage: tsx tools/sync-template-versions.ts <version>");
  process.exit(1);
}

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

const result = spawnSync("npm", ["install"], {
  cwd: join(ROOT, "template"),
  stdio: "inherit",
  shell: true,
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log("✓ template/package-lock.json updated (npm install)");

/**
 * Stages a standalone workspace package (one without bundled workspace
 * dependencies, such as @databricks/lakebase) in `tmp/` for `npm pack`:
 * applies `publishConfig.exports`, an optional prerelease version, and copies
 * dist, README, LICENSE, and DCO.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const { values } = parseArgs({
  options: {
    prerelease: { type: "string" },
  },
});
const prerelease = values.prerelease;

fs.mkdirSync("tmp", { recursive: true });

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
if (prerelease) {
  pkg.version = `${pkg.version}-pr.${prerelease}`;
}

pkg.exports = pkg.publishConfig.exports;
delete pkg.publishConfig.exports;

fs.writeFileSync("tmp/package.json", JSON.stringify(pkg, null, 2));

fs.cpSync("dist", "tmp/dist", { recursive: true });

// Use the package's own README.md if present, otherwise fall back to the root one
const localReadme = "README.md";
const rootReadme = path.join(__dirname, "../README.md");
fs.copyFileSync(
  fs.existsSync(localReadme) ? localReadme : rootReadme,
  "tmp/README.md",
);
fs.copyFileSync(path.join(__dirname, "../LICENSE"), "tmp/LICENSE");
fs.copyFileSync(path.join(__dirname, "../DCO"), "tmp/DCO");

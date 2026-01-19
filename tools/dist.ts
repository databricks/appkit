import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

fs.mkdirSync("tmp", { recursive: true });

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));

delete pkg.dependencies.shared;

pkg.exports = pkg.publishConfig.exports;
delete pkg.publishConfig.exports;

const isAppKitPackage = pkg.name?.startsWith("@databricks/appkit");
const sharedBin = path.join(__dirname, "../packages/shared/bin/appkit.js");
const sharedPostinstall = path.join(
  __dirname,
  "../packages/shared/scripts/postinstall.js",
);

// Add appkit bin and postinstall for @databricks/appkit* packages
if (isAppKitPackage) {
  if (fs.existsSync(sharedBin)) {
    pkg.bin = pkg.bin || {};
    pkg.bin["appkit"] = "./bin/appkit.js";
  }
  if (fs.existsSync(sharedPostinstall)) {
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.postinstall = "node scripts/postinstall.js";
  }
}

fs.writeFileSync("tmp/package.json", JSON.stringify(pkg, null, 2));

fs.cpSync("dist", "tmp/dist", { recursive: true });

if (fs.existsSync("bin")) {
  fs.cpSync("bin", "tmp/bin", { recursive: true });
}

// Copy bin and scripts from shared package
if (isAppKitPackage) {
  if (fs.existsSync(sharedBin)) {
    fs.mkdirSync("tmp/bin", { recursive: true });
    fs.copyFileSync(sharedBin, "tmp/bin/appkit.js");
  }
  if (fs.existsSync(sharedPostinstall)) {
    fs.mkdirSync("tmp/scripts", { recursive: true });
    fs.copyFileSync(sharedPostinstall, "tmp/scripts/postinstall.js");
  }
}

// Copy documentation from docs/build
const docsBuildPath = path.join(__dirname, "../docs/build");

// Copy llms.txt
fs.copyFileSync(path.join(docsBuildPath, "llms.txt"), "tmp/llms.txt");

// Copy llms.txt as CLAUDE.md and AGENTS.md (npm pack doesn't support symlinks)
fs.copyFileSync("tmp/llms.txt", "tmp/CLAUDE.md");
fs.copyFileSync("tmp/llms.txt", "tmp/AGENTS.md");

// Copy markdown documentation structure
const docsPath = path.join(docsBuildPath, "docs");
if (fs.existsSync(docsPath)) {
  fs.cpSync(docsPath, "tmp/docs", { recursive: true });
}

fs.copyFileSync(path.join(__dirname, "../README.md"), "tmp/README.md");
fs.copyFileSync(path.join(__dirname, "../LICENSE"), "tmp/LICENSE");
fs.copyFileSync(path.join(__dirname, "../DCO"), "tmp/DCO");
fs.copyFileSync(path.join(__dirname, "../NOTICE.md"), "tmp/NOTICE.md");

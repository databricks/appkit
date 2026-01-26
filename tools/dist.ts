import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Read CLI dependencies from shared package
const sharedPkgPath = path.join(__dirname, "../packages/shared/package.json");
const sharedPkg = JSON.parse(fs.readFileSync(sharedPkgPath, "utf-8"));
const CLI_DEPENDENCIES = sharedPkg.dependencies;

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
    pkg.bin.appkit = "./bin/appkit.js";
  }
  if (fs.existsSync(sharedPostinstall)) {
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.postinstall = "node scripts/postinstall.js";
  }

  // Add CLI dependencies from shared package (required for bin commands to work)
  pkg.dependencies = pkg.dependencies || {};
  Object.assign(pkg.dependencies, CLI_DEPENDENCIES);
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

    // Copy CLI code from shared/dist/cli to tmp/dist/cli
    const sharedCliDist = path.join(__dirname, "../packages/shared/dist/cli");
    if (fs.existsSync(sharedCliDist)) {
      const tmpCliDist = "tmp/dist/cli";
      fs.mkdirSync(tmpCliDist, { recursive: true });
      fs.cpSync(sharedCliDist, tmpCliDist, { recursive: true });
    }
  }
  if (fs.existsSync(sharedPostinstall)) {
    fs.mkdirSync("tmp/scripts", { recursive: true });
    fs.copyFileSync(sharedPostinstall, "tmp/scripts/postinstall.js");
  }
}

// Copy documentation from docs/build into tmp/docs/
const docsBuildPath = path.join(__dirname, "../docs/build");

// Copy all .md files and docs/ subdirectory from docs/build to tmp/docs
fs.mkdirSync("tmp/docs", { recursive: true });

// Copy all files and directories we want, preserving structure
const itemsToCopy = fs.readdirSync(docsBuildPath);
for (const item of itemsToCopy) {
  const sourcePath = path.join(docsBuildPath, item);
  const stat = fs.statSync(sourcePath);

  // Copy .md files and docs directory
  if (item.endsWith(".md") || item === "docs") {
    const destPath = path.join("tmp/docs", item);
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

// Process llms.txt (keep existing logic but update path replacement)
const llmsSourcePath = path.join(docsBuildPath, "llms.txt");
let llmsContent = fs.readFileSync(llmsSourcePath, "utf-8");

// Replace /appkit/ with ./docs/ to match new structure
llmsContent = llmsContent.replace(/\/appkit\//g, "./docs/");

// Prepend AI agent guidance for navigating documentation
const agentGuidance = `## For AI Agents/Assistants

To view specific documentation files referenced below, use the appkit CLI:

\`\`\`bash
npx @databricks/appkit docs <path>
\`\`\`

Examples:
- View main documentation: \`npx @databricks/appkit docs\`
- View specific file: \`npx @databricks/appkit docs ./docs/docs.md\`
- View API reference: \`npx @databricks/appkit docs ./docs/docs/api.md\`
- View component docs: \`npx @databricks/appkit docs ./docs/docs/api/appkit-ui/components/Sidebar.md\`

The CLI will display the documentation content directly in the terminal.

---

`;

llmsContent = agentGuidance + llmsContent;

fs.writeFileSync("tmp/llms.txt", llmsContent);

// Copy llms.txt as CLAUDE.md (npm pack doesn't support symlinks)
fs.copyFileSync("tmp/llms.txt", "tmp/CLAUDE.md");

fs.copyFileSync(path.join(__dirname, "../README.md"), "tmp/README.md");
fs.copyFileSync(path.join(__dirname, "../LICENSE"), "tmp/LICENSE");
fs.copyFileSync(path.join(__dirname, "../DCO"), "tmp/DCO");
fs.copyFileSync(path.join(__dirname, "../NOTICE.md"), "tmp/NOTICE.md");

import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Read CLI dependencies from shared package
const sharedPkgPath = path.join(__dirname, "../packages/shared/package.json");
const sharedPkg = JSON.parse(fs.readFileSync(sharedPkgPath, "utf-8"));
const CLI_DEPENDENCIES = sharedPkg.dependencies;

fs.mkdirSync("tmp", { recursive: true });

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));

// Packages that are workspace-local but published separately — replace workspace:* with real version.
// "shared" is intentionally excluded: it is bundled directly into appkit/appkit-ui via noExternal.
const WORKSPACE_PACKAGE_REPLACEMENTS = ["@databricks/lakebase"];

delete pkg.dependencies.shared;

for (const depName of WORKSPACE_PACKAGE_REPLACEMENTS) {
  if (pkg.dependencies?.[depName] === "workspace:*") {
    const pkgDirName = depName.split("/").pop() ?? depName;
    const depPkgPath = path.join(
      __dirname,
      `../packages/${pkgDirName}/package.json`,
    );
    const depPkg = JSON.parse(fs.readFileSync(depPkgPath, "utf-8"));
    pkg.dependencies[depName] = `${depPkg.version}`;
  }
}

pkg.exports = pkg.publishConfig.exports;
delete pkg.publishConfig.exports;

const sharedBin = path.join(__dirname, "../packages/shared/bin/appkit.js");
const sharedPostinstall = path.join(
  __dirname,
  "../packages/shared/scripts/postinstall.js",
);

// Add appkit bin and postinstall
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

fs.writeFileSync("tmp/package.json", JSON.stringify(pkg, null, 2));

fs.cpSync("dist", "tmp/dist", { recursive: true });

if (fs.existsSync("bin")) {
  fs.cpSync("bin", "tmp/bin", { recursive: true });
}

// Copy bin and scripts from shared package
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

  // Copy JSON schemas so CLI (e.g. plugin validate/sync) can load them at runtime.
  // Place in both dist/schemas and dist/cli/schemas so resolution works whether
  // the running module's __dirname is under dist/ or dist/cli/ (e.g. after bundling).
  const sharedDistSchemas = path.join(
    __dirname,
    "../packages/shared/dist/schemas",
  );
  const sharedSrcSchemas = path.join(
    __dirname,
    "../packages/shared/src/schemas",
  );
  const sharedSchemas = fs.existsSync(sharedDistSchemas)
    ? sharedDistSchemas
    : sharedSrcSchemas;
  if (fs.existsSync(sharedSchemas)) {
    const dest = "tmp/dist/schemas";
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(sharedSchemas, dest, { recursive: true });
  }
}
if (fs.existsSync(sharedPostinstall)) {
  fs.mkdirSync("tmp/scripts", { recursive: true });
  fs.copyFileSync(sharedPostinstall, "tmp/scripts/postinstall.js");
}

// Copy documentation from docs/build into tmp/docs/
const docsBuildPath = path.join(__dirname, "../docs/build");

function copyMdFilesRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyMdFilesRecursive(srcPath, destPath);
    } else if (entry.endsWith(".md")) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Flatten docs/build/docs/ .md files into tmp/docs/, plus top-level .md files
fs.mkdirSync("tmp/docs", { recursive: true });

const itemsToCopy = fs.readdirSync(docsBuildPath);
for (const item of itemsToCopy) {
  const sourcePath = path.join(docsBuildPath, item);
  const stat = fs.statSync(sourcePath);

  if (item === "docs" && stat.isDirectory()) {
    copyMdFilesRecursive(sourcePath, "tmp/docs");
  } else if (item.endsWith(".md")) {
    fs.copyFileSync(sourcePath, path.join("tmp", item));
  }
}

// Replace Docusaurus URL paths with local relative paths.
// Step 1: /appkit/docs/... -> ./docs/... (strips baseUrl + docs route, avoids mid-path "api/appkit/")
// Step 2: remaining /appkit/... at markdown link positions -> ./... (e.g., /appkit/docs.md -> ./docs.md)
function replaceDocPaths(content: string): string {
  content = content.replace(/(?<=\()\/appkit\/docs\//g, "./docs/");
  content = content.replace(/(?<=\()\/appkit\/docs\.md/g, "./docs.md"); // special case for root "Getting started" path ("/")
  return content;
}

function processDocsLinks(dir: string) {
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      processDocsLinks(fullPath);
    } else if (entry.endsWith(".md")) {
      fs.writeFileSync(
        fullPath,
        replaceDocPaths(fs.readFileSync(fullPath, "utf-8")),
      );
    }
  }
}

// Process links in all copied .md files
processDocsLinks("tmp/docs");
for (const entry of fs.readdirSync("tmp")) {
  if (entry.endsWith(".md")) {
    const fullPath = path.join("tmp", entry);
    fs.writeFileSync(
      fullPath,
      replaceDocPaths(fs.readFileSync(fullPath, "utf-8")),
    );
  }
}

// Process llms.txt
const llmsSourcePath = path.join(docsBuildPath, "llms.txt");
let llmsContent = replaceDocPaths(fs.readFileSync(llmsSourcePath, "utf-8"));

// Prepend AI agent guidance for navigating documentation
const agentGuidance = `## For AI Agents/Assistants

The paths in the markdown links below (e.g. \`./docs.md\`, \`./docs/api.md\`) can be passed directly as the \`<path>\` argument to view that page:

\`\`\`bash
npx @databricks/appkit docs <path>
\`\`\`

Examples:
- View main documentation: \`npx @databricks/appkit docs\`
- View Getting Started: \`npx @databricks/appkit docs ./docs.md\`
- View API reference: \`npx @databricks/appkit docs ./docs/api.md\`
- View component docs: \`npx @databricks/appkit docs ./docs/api/appkit-ui/components/Sidebar.md\`

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

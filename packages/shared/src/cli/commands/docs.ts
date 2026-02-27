import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findPackageRoot(): string {
  let dir = __dirname;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not find package root");
}

function runDocs(docPath?: string) {
  const packageRoot = findPackageRoot();

  if (!docPath) {
    // Display llms.txt by default
    const llmsPath = path.join(packageRoot, "llms.txt");

    if (!fs.existsSync(llmsPath)) {
      console.error("Error: llms.txt not found in package");
      process.exit(1);
    }

    const content = fs.readFileSync(llmsPath, "utf-8");
    console.log(content);
    return;
  }

  // Handle path - remove leading ./ and / first, then strip prefixes
  let normalizedPath = docPath;

  // Strip leading ./ or /
  normalizedPath = normalizedPath.replace(/^\.\//, "");
  normalizedPath = normalizedPath.replace(/^\//, "");

  // Strip appkit/ baseUrl prefix if present (paths resolve relative to packageRoot)
  normalizedPath = normalizedPath.replace(/^appkit\//, "");

  const fullPath = path.join(packageRoot, normalizedPath);

  if (!fs.existsSync(fullPath)) {
    console.error(`Error: Documentation file not found: ${docPath}`);
    console.error(`Tried: ${fullPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  console.log(content);
}

export const docsCommand = new Command("docs")
  .description("Display embedded documentation")
  .argument(
    "[path]",
    "Path to specific documentation file (e.g., ./docs/api/appkit-ui/components/Sidebar.md)",
  )
  .action(runDocs);

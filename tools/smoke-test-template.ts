#!/usr/bin/env tsx
/**
 * Smoke test for the committed template.
 *
 * Scaffolds the template into a scratch directory with rendered placeholders,
 * then optionally installs with the selected package manager, exercises the
 * native parser, builds, and checks HTTP startup.
 *
 * Go template placeholders are rendered with simple values:
 * - {{.projectName}} → smoke-test-app
 * - {{.appDescription}} → Smoke test app
 * - {{.appEnv}} → (empty, which means the conditional block is omitted)
 *
 * Usage:
 *   tsx tools/smoke-test-template.ts [--output-dir <path>] [--package-manager <pm>] [--run]
 *
 * Options:
 *   --output-dir        Optional. Scratch directory for the scaffolded app.
 *                       Must be under .smoke-test. Defaults to ".smoke-test/app".
 *   --package-manager   Optional. Package manager to scaffold (pnpm or npm).
 *                       Defaults to "pnpm". (short: -p)
 *   --run              Install, build with prebuild, and check HTTP startup.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  runTemplateSmoke,
  selectSmokePackageManager,
} from "./template-smoke-runner";

const ROOT = process.cwd();

const { values } = parseArgs({
  options: {
    "output-dir": { type: "string", default: ".smoke-test/app" },
    "package-manager": { type: "string", default: "pnpm", short: "p" },
    run: { type: "boolean", default: false },
  },
  strict: true,
});

// oxlint-disable-next-line typescript/no-non-null-assertion -- default value guarantees this is defined
const outputDir = values["output-dir"]!;
// oxlint-disable-next-line typescript/no-non-null-assertion -- default value guarantees this is defined
const packageManager = values["package-manager"]!;
const SCRATCH_DIR = resolve(ROOT, outputDir);

if (packageManager !== "npm" && packageManager !== "pnpm") {
  throw new Error(`Unsupported package manager: ${packageManager}`);
}
if (!SCRATCH_DIR.startsWith(`${join(ROOT, ".smoke-test")}/`)) {
  throw new Error("Smoke output must be a subdirectory of .smoke-test");
}

// Clean up any prior run
if (existsSync(SCRATCH_DIR)) {
  rmSync(SCRATCH_DIR, { recursive: true });
}
mkdirSync(SCRATCH_DIR, { recursive: true });

// Copy the template
const templateSrc = join(ROOT, "template");
cpSync(templateSrc, SCRATCH_DIR, { recursive: true });
console.log(`✓ Copied template → ${outputDir}`);

selectSmokePackageManager(SCRATCH_DIR, packageManager);

// Render placeholders in key files
const placeholders = {
  "{{.projectName}}": "smoke-test-app",
  "{{.appDescription}}": "Smoke test app",
  '{{or .packageManager "pnpm"}}': packageManager,
};

/**
 * Recursively process all files in the scaffold directory to:
 * 1. Replace simple placeholders ({{.projectName}}, {{.appDescription}})
 * 2. Remove Go template conditionals for plugins and appEnv
 */
function processAllFiles(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip node_modules, dist, and hidden directories
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      (entry.isDirectory() && entry.name.startsWith("."))
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      processAllFiles(fullPath);
    } else if (
      entry.isFile() &&
      (fullPath.endsWith(".tsx") ||
        fullPath.endsWith(".ts") ||
        fullPath.endsWith(".json") ||
        fullPath.endsWith(".html") ||
        fullPath.endsWith(".tmpl") ||
        fullPath.endsWith(".yaml") ||
        fullPath.endsWith(".yml"))
    ) {
      let content = readFileSync(fullPath, "utf-8");
      let modified = false;

      // Replace simple placeholders
      for (const [key, value] of Object.entries(placeholders)) {
        if (content.includes(key)) {
          content = content.replaceAll(key, value);
          modified = true;
        }
      }

      // Remove Go template conditionals: {{- if .appEnv}} blocks
      if (content.includes("{{") && content.includes(".appEnv")) {
        const beforeLen = content.length;
        content = content.replace(
          /{{-?\s*if\s+\.appEnv\s*}}[\s\S]*?{{-?\s*end\s*}}/g,
          "",
        );
        if (beforeLen !== content.length) {
          modified = true;
        }
      }

      // Remove Go template conditionals: {{- if .plugins.*}} blocks
      if (content.includes("{{") && content.includes(".plugins.")) {
        const beforeLen = content.length;
        content = content.replace(
          /{{-?\s*if\s+\.plugins\.[a-zA-Z0-9_-]+\s*-?\s*}}[\s\S]*?{{-?\s*end\s*-?\s*}}/g,
          "",
        );
        if (beforeLen !== content.length) {
          modified = true;
        }
      }

      if (modified) {
        if (content.trim()) writeFileSync(fullPath, content);
        else rmSync(fullPath);
      }
    }
  }
}

processAllFiles(SCRATCH_DIR);

// Special handling for server.ts: it's almost entirely Go template code that needs Databricks CLI rendering.
// For the smoke test, replace it with a minimal valid server that compiles without needing plugin configuration.
const serverTsPath = join(SCRATCH_DIR, "server/server.ts");
if (existsSync(serverTsPath)) {
  const minimalServer = `import { createApp, server } from '@databricks/appkit';

createApp({
  plugins: [server()],
  disableInternalTelemetry: true,
}).catch((error) => { console.error(error); process.exitCode = 1; });
`;
  writeFileSync(serverTsPath, minimalServer);
}

// Handle .tmpl file renaming
const tmplRenames = [
  ["app.yaml.tmpl", "app.yaml"],
  ["README.md.tmpl", "README.md"],
  [".env.tmpl", ".env"],
  [".env.example.tmpl", ".env.example"],
  ["databricks.yml.tmpl", "databricks.yml"],
];

for (const [src, dst] of tmplRenames) {
  const srcPath = join(SCRATCH_DIR, src);
  const dstPath = join(SCRATCH_DIR, dst);
  if (existsSync(srcPath)) {
    writeFileSync(dstPath, readFileSync(srcPath, "utf-8"));
    rmSync(srcPath);
  }
}

// The server-only fixture has no workspace resources or local credentials.
writeFileSync(join(SCRATCH_DIR, ".env"), "");

// Rename _gitignore to .gitignore
const gitignoreSrc = join(SCRATCH_DIR, "_gitignore");
const gitignoreDst = join(SCRATCH_DIR, ".gitignore");
if (existsSync(gitignoreSrc)) {
  writeFileSync(gitignoreDst, readFileSync(gitignoreSrc, "utf-8"));
  rmSync(gitignoreSrc);
}

console.log(
  "✓ Rendered placeholders, stripped Go template conditionals, and renamed .tmpl files",
);
console.log(`\nTemplate scaffolded to ${SCRATCH_DIR}`);
if (values.run) {
  await runTemplateSmoke(SCRATCH_DIR, packageManager);
} else if (packageManager === "pnpm") {
  console.log("Next step: pnpm install --frozen-lockfile in that directory");
} else if (packageManager === "npm") {
  console.log("Next step: npm install in that directory");
}

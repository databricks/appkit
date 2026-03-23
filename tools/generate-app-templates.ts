#!/usr/bin/env tsx

/**
 * Generates static app template variants using `databricks apps init` with the local template.
 * Each entry in APP_TEMPLATES produces one output app in the output directory.
 *
 * Output directory: ../app-templates (relative to repo root) by default.
 * Override with the APP_TEMPLATES_OUTPUT_DIR environment variable.
 *
 * The Databricks CLI binary defaults to "databricks".
 * Override with the DATABRICKS_CLI environment variable (e.g. DATABRICKS_CLI=dbx).
 *
 * Usage:
 *   tsx tools/generate-app-templates.ts
 *   APP_TEMPLATES_OUTPUT_DIR=/tmp/my-apps tsx tools/generate-app-templates.ts
 *   DATABRICKS_CLI=dbx tsx tools/generate-app-templates.ts
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const OUTPUT_DIR = process.env.APP_TEMPLATES_OUTPUT_DIR
  ? resolve(process.env.APP_TEMPLATES_OUTPUT_DIR)
  : resolve(ROOT, "../app-templates");

const TEMPLATE_PATH = join(ROOT, "template");

const DATABRICKS_CLI = process.env.DATABRICKS_CLI ?? "databricks";

const APPKIT_SECTION_START = "<!-- appkit-start -->";
const APPKIT_SECTION_END = "<!-- appkit-end -->";

interface AppTemplate {
  /** Output directory name and --name passed to databricks apps init */
  name: string;
  /** Plugin features to enable (--features) */
  features: string[];
  /** Resource values as plugin.resourceKey.field → value (each becomes a --set flag) */
  set?: Record<string, string>;
  /** App description — passed to --description and used in the README table */
  description: string;
}

const FEATURE_DEPENDENCIES: Record<string, string> = {
  analytics: "SQL warehouse",
  files: "Volume",
  genie: "Genie Space",
  lakebase: "Database",
};

const APP_TEMPLATES: AppTemplate[] = [
  {
    name: "appkit-all-in-one",
    features: ["analytics", "files", "genie", "lakebase"],
    set: {
      "analytics.sql-warehouse.id": "placeholder",
      "files.files.path": "placeholder",
      "genie.genie-space.id": "placeholder",
      "lakebase.postgres.branch": "placeholder",
      "lakebase.postgres.database": "placeholder",
    },
    description:
      "Full-stack Node.js app with SQL analytics dashboards, file browser, Genie AI conversations, and Lakebase Autoscaling (Postgres) CRUD",
  },
  {
    name: "appkit-analytics",
    features: ["analytics"],
    set: {
      "analytics.sql-warehouse.id": "placeholder",
    },
    description: "Node.js app with SQL analytics dashboards and charts",
  },
  {
    name: "appkit-genie",
    features: ["genie"],
    set: {
      "genie.genie-space.id": "placeholder",
    },
    description:
      "Node.js app with AI/BI Genie for natural language data queries",
  },
  {
    name: "appkit-files",
    features: ["files"],
    set: {
      "files.files.path": "placeholder",
    },
    description: "Node.js app with file browser for Databricks Volumes",
  },
  {
    name: "appkit-lakebase",
    features: ["lakebase"],
    set: {
      "lakebase.postgres.branch": "placeholder",
      "lakebase.postgres.database": "placeholder",
    },
    description:
      "Node.js app with Lakebase Autoscaling (Postgres) CRUD operations",
  },
];

function run(cmd: string, args: string[], opts?: { cwd?: string }): number {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: opts?.cwd });
  return result.status ?? 1;
}

console.log(`Output directory: ${OUTPUT_DIR}\n`);
mkdirSync(OUTPUT_DIR, { recursive: true });

for (const app of APP_TEMPLATES) {
  const appDir = join(OUTPUT_DIR, app.name);

  console.log(`\n── Generating ${app.name} ──`);

  // Remove existing output so databricks apps init doesn't complain the dir exists
  rmSync(appDir, { recursive: true, force: true });

  const args = [
    "apps",
    "init",
    "--template",
    TEMPLATE_PATH,
    "--name",
    app.name,
    "--features",
    app.features.join(","),
    "--output-dir",
    OUTPUT_DIR,
  ];

  args.push("--description", app.description);

  for (const [key, value] of Object.entries(app.set ?? {})) {
    args.push("--set", `${key}=${value}`);
  }

  const status = run(DATABRICKS_CLI, args);
  if (status !== 0) {
    console.error(`\nFailed to generate ${app.name} (exit code ${status})`);
    process.exit(status);
  }

  postProcess(appDir, app);
}

updateReadme();

console.log(
  `\n✓ Generated ${APP_TEMPLATES.length} app templates in ${OUTPUT_DIR}`,
);

/**
 * Post-processes a generated template to clean it up for publishing:
 * - Deletes .env (contains resolved credentials from the generator's CLI profile)
 * - Syncs appkit.plugins.json via `appkit plugin sync --write`
 * - Replaces the resolved workspace host URL in databricks.yml with a placeholder
 */
function postProcess(appDir: string, app: AppTemplate): void {
  console.log(`  Post-processing ${app.name}...`);

  // 1. Delete .env (contains resolved credentials from the generator's CLI profile)
  //    and write .env.tmpl with a header comment so that `databricks apps init`
  //    can render it for end users when they scaffold from the published template.
  rmSync(join(appDir, ".env"), { force: true });

  const envTmplHeader = [
    "# This file is a Go template processed by `databricks apps init --template <path>`.",
    "# Template variables are substituted and the result is written as .env.",
    "",
  ].join("\n");
  const envTmplBody = readFileSync(join(TEMPLATE_PATH, ".env.tmpl"), "utf-8");
  writeFileSync(join(appDir, ".env.tmpl"), envTmplHeader + envTmplBody);

  // 2. Sync appkit.plugins.json based on server imports (discovers available plugins
  //    and marks the ones used in the plugins array as required).
  const syncStatus = run(
    "node",
    [join(ROOT, "packages/shared/bin/appkit.js"), "plugin", "sync", "--write"],
    { cwd: appDir },
  );
  if (syncStatus !== 0) {
    console.error(`  Failed to sync plugins for ${app.name}`);
    process.exit(syncStatus);
  }

  // 3. Replace the resolved workspace host URL with a placeholder.
  const databricksYmlPath = join(appDir, "databricks.yml");
  const yml = readFileSync(databricksYmlPath, "utf-8");
  const fixedYml = yml.replace(
    /host:\s+https:\/\/\S+/g,
    "host: https://your-workspace.cloud.databricks.com",
  );
  writeFileSync(databricksYmlPath, fixedYml);
}

/**
 * Updates the AppKit section in the output directory's README.md.
 * The section is delimited by HTML comment markers for idempotent replacement.
 * If the markers don't exist yet, the section is appended at the end.
 */
function updateReadme(): void {
  const readmePath = join(OUTPUT_DIR, "README.md");
  if (!existsSync(readmePath)) {
    console.log("  Skipping README update (file not found)");
    return;
  }

  console.log("\nUpdating AppKit section in README.md...");

  const rows = APP_TEMPLATES.map((app) => {
    const deps = app.features
      .map((f) => FEATURE_DEPENDENCIES[f])
      .filter(Boolean)
      .join(", ");
    return `| \`${app.name}\` | ${app.description} | ${deps || "None"} |`;
  });

  const section = [
    APPKIT_SECTION_START,
    "",
    "| Template | Description | Dependencies |",
    "|----------|-------------|--------------|",
    ...rows,
    "",
    APPKIT_SECTION_END,
  ].join("\n");

  const readme = readFileSync(readmePath, "utf-8");
  const startIdx = readme.indexOf(APPKIT_SECTION_START);
  const endIdx = readme.indexOf(APPKIT_SECTION_END);

  let updated: string;
  if (startIdx !== -1 && endIdx !== -1) {
    updated =
      readme.slice(0, startIdx) +
      section +
      readme.slice(endIdx + APPKIT_SECTION_END.length);
  } else {
    updated = `${readme.trimEnd()}\n\n### AppKit\n\n${section}\n`;
  }

  writeFileSync(readmePath, updated);
}

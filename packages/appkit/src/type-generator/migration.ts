import fs from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { createLogger } from "../logging/logger";

const logger = createLogger("type-generator:migration");

/**
 * Derive project root from an outFile path.
 * outFile is always `<projectRoot>/shared/appkit-types/<file>` — both the Vite plugins
 * and the CLI construct it this way, so going up two levels is safe.
 */
export function resolveProjectRoot(outFile: string): string {
  return path.resolve(path.dirname(outFile), "..", "..");
}

/**
 * Remove old generated types from client/src/appkit-types/ (pre-shared/ location).
 * Best-effort: silently ignores missing files.
 */
export async function removeOldGeneratedTypes(
  projectRoot: string,
  filename: string,
): Promise<void> {
  const oldFile = path.join(
    projectRoot,
    "client",
    "src",
    "appkit-types",
    filename,
  );
  try {
    await fs.unlink(oldFile);
    logger.debug("Removed old types at %s", oldFile);
  } catch {
    // File doesn't exist — nothing to clean up
  }
}

// ── Project config migration ────────────────────────────────────────────

let migrationDone = false;

/**
 * One-time config migration: update tsconfig and package.json for shared/ types output.
 * Idempotent — each sub-migration checks current file state and skips if already migrated.
 * Opt-out: set `"appkit": { "autoMigrate": false }` in package.json.
 */
export async function migrateProjectConfig(projectRoot: string): Promise<void> {
  if (migrationDone) return;
  migrationDone = true;

  if (await isAutoMigrateDisabled(projectRoot)) {
    logger.debug("Auto-migration disabled via package.json appkit.autoMigrate");
    return;
  }

  const results: Array<{ file: string; action: string }> = [];

  results.push(...(await migrateTsconfigClient(projectRoot)));
  results.push(...(await migrateTsconfigServer(projectRoot)));
  results.push(...(await migratePackageJsonScripts(projectRoot)));

  if (results.length > 0) {
    printMigrationSummary(results);
  }
}

/** Exported for testing only. */
export function _resetMigrationState(): void {
  migrationDone = false;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function isAutoMigrateDisabled(projectRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(projectRoot, "package.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    return parsed.appkit?.autoMigrate === false;
  } catch {
    return false;
  }
}

/** Strip JSONC comments (block and line) so JSON.parse can handle tsconfig files. */
function stripJsonComments(text: string): string {
  // Match strings (to skip them) or comments (to remove them).
  // Strings must be matched first to avoid stripping comment-like patterns inside string values
  // (e.g. "server/**/*" contains /* which looks like a block comment start).
  return text.replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/.*/g, (match) =>
    match.startsWith('"') ? match : "",
  );
}

type MigrationResult = Array<{ file: string; action: string }>;

// ── tsconfig.client.json ────────────────────────────────────────────────

async function migrateTsconfigClient(
  projectRoot: string,
): Promise<MigrationResult> {
  const results: MigrationResult = [];
  const filePath = path.join(projectRoot, "tsconfig.client.json");

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(stripJsonComments(raw));

    if (!Array.isArray(parsed.include)) return results;
    if (parsed.include.includes("shared/appkit-types")) return results;

    parsed.include.push("shared/appkit-types");
    await fs.writeFile(
      filePath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf-8",
    );
    results.push({
      file: "tsconfig.client.json",
      action: 'added "shared/appkit-types" to include',
    });
  } catch {
    // File missing or unparseable — skip silently
  }

  return results;
}

// ── tsconfig.server.json ────────────────────────────────────────────────

async function migrateTsconfigServer(
  projectRoot: string,
): Promise<MigrationResult> {
  const results: MigrationResult = [];
  const filePath = path.join(projectRoot, "tsconfig.server.json");

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(stripJsonComments(raw));
    const opts = parsed.compilerOptions;

    if (!opts || !opts.outDir) return results; // already migrated or non-standard

    delete opts.outDir;
    delete opts.declaration;
    delete opts.declarationMap;
    delete opts.sourceMap;
    opts.noEmit = true;

    await fs.writeFile(
      filePath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf-8",
    );
    results.push({
      file: "tsconfig.server.json",
      action: "switched to noEmit mode",
    });
  } catch {
    // File missing or unparseable — skip silently
  }

  return results;
}

// ── package.json ────────────────────────────────────────────────────────

const SCRIPT_MIGRATIONS: Record<string, { old: string; new: string }> = {
  "build:server": {
    old: "tsdown -c tsdown.server.config.ts",
    new: "tsc -b tsconfig.server.json && tsdown -c tsdown.server.config.ts",
  },
  typecheck: {
    old: "tsc -p ./tsconfig.server.json --noEmit && tsc -p ./tsconfig.client.json --noEmit",
    new: "tsc -b tsconfig.server.json && tsc -b tsconfig.client.json",
  },
};

async function migratePackageJsonScripts(
  projectRoot: string,
): Promise<MigrationResult> {
  const results: MigrationResult = [];
  const filePath = path.join(projectRoot, "package.json");

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const scripts = parsed.scripts;
    if (!scripts) return results;

    const updated: string[] = [];

    for (const [name, { old, new: replacement }] of Object.entries(
      SCRIPT_MIGRATIONS,
    )) {
      if (scripts[name] === old) {
        scripts[name] = replacement;
        updated.push(name);
      }
    }

    if (updated.length === 0) return results;

    const indent = raw.match(/^\s+/m)?.[0]?.length === 4 ? 4 : 2;
    await fs.writeFile(
      filePath,
      `${JSON.stringify(parsed, null, indent)}\n`,
      "utf-8",
    );
    results.push({
      file: "package.json",
      action: `updated ${updated.join(" and ")} scripts`,
    });
  } catch {
    // File missing or unparseable — skip silently
  }

  return results;
}

// ── Summary ─────────────────────────────────────────────────────────────

function printMigrationSummary(
  results: Array<{ file: string; action: string }>,
) {
  const separator = pc.dim("─".repeat(50));
  console.log("");
  console.log(`  ${pc.bold("Typegen Migration")}`);
  console.log(`  ${separator}`);
  for (const { file, action } of results) {
    console.log(`  ${pc.green("✓")} ${file.padEnd(24)} ${pc.dim(action)}`);
  }
  console.log(`  ${separator}`);
  console.log("");
}

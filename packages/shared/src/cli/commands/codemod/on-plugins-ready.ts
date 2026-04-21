import fs from "node:fs";
import path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { Command } from "commander";

const SEARCH_DIRS = ["server", "src", "."];
const CANDIDATE_NAMES = ["server.ts", "index.ts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

function findServerEntryFiles(rootDir: string): string[] {
  const results: string[] = [];

  for (const dir of SEARCH_DIRS) {
    const absDir = path.resolve(rootDir, dir);
    if (!fs.existsSync(absDir)) continue;

    const files =
      dir === "."
        ? CANDIDATE_NAMES.map((n) => path.join(absDir, n)).filter(fs.existsSync)
        : findTsFiles(absDir);

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      if (
        content.includes("createApp") &&
        content.includes("@databricks/appkit")
      ) {
        results.push(file);
      }
    }
  }

  return [...new Set(results)];
}

function findTsFiles(dir: string, files: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findTsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function isAlreadyMigrated(content: string): boolean {
  const ast = parse(Lang.TypeScript, content);
  const root = ast.root();
  return root.findAll("createApp({ $$$PROPS })").some((match) => {
    const text = match.text();
    return /\bonPluginsReady\s*[(:]/.test(text);
  });
}

/**
 * Find the index of the matching closing delimiter for an opening one.
 * Supports (), {}, and [].
 */
function findMatchingClose(content: string, openIdx: number): number {
  const open = content[openIdx];
  const closeMap: Record<string, string> = {
    "(": ")",
    "{": "}",
    "[": "]",
  };
  const close = closeMap[open];
  if (!close) return -1;

  let depth = 1;
  let i = openIdx + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === open) depth++;
    else if (ch === close) depth--;

    // skip string literals
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(content, i);
      continue;
    }
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function skipString(content: string, startIdx: number): number {
  const quote = content[startIdx];
  let i = startIdx + 1;
  while (i < content.length) {
    if (content[i] === "\\") {
      i += 2;
      continue;
    }
    if (content[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function stripAutoStartFromServerCalls(content: string): string {
  return content.replace(
    /server\(\{([^}]*)\}\)/g,
    (_fullMatch, propsStr: string) => {
      const cleaned = propsStr
        .replace(/autoStart\s*:\s*(true|false)\s*,?\s*/g, "")
        .replace(/,\s*$/, "")
        .trim();
      if (!cleaned) return "server()";
      return `server({ ${cleaned} })`;
    },
  );
}

interface MigrationResult {
  migrated: boolean;
  content: string;
  warnings: string[];
}

function migratePatternA(content: string): MigrationResult {
  const warnings: string[] = [];

  // Find createApp(...).then(
  const createAppIdx = content.indexOf("createApp(");
  if (createAppIdx === -1) return { migrated: false, content, warnings };

  // Find the opening paren of createApp(
  const configOpenParen = content.indexOf("(", createAppIdx);
  const configCloseParen = findMatchingClose(content, configOpenParen);
  if (configCloseParen === -1) return { migrated: false, content, warnings };

  // Check for .then( after the closing paren
  const afterCreateApp = content.slice(configCloseParen + 1);
  const thenMatch = afterCreateApp.match(/^\s*\.then\s*\(/);
  if (!thenMatch) return { migrated: false, content, warnings };

  const thenStart = configCloseParen + 1 + afterCreateApp.indexOf(".then");
  const thenOpenParen = content.indexOf("(", thenStart + 4);
  const thenCloseParen = findMatchingClose(content, thenOpenParen);
  if (thenCloseParen === -1) return { migrated: false, content, warnings };

  // Extract the callback inside .then(...)
  const thenRaw = content.slice(thenOpenParen + 1, thenCloseParen);
  const thenInner = thenRaw.trim();

  // Parse callback: (param) => { body } or async (param) => { body }
  const callbackMatch = thenInner.match(
    /^(?:async\s+)?\(\s*(\w+)\s*\)\s*=>\s*\{/,
  );
  if (!callbackMatch) return { migrated: false, content, warnings };

  const paramName = callbackMatch[1];
  const bodyOpenBrace = thenOpenParen + 1 + thenRaw.indexOf("{");
  const bodyCloseBrace = findMatchingClose(content, bodyOpenBrace);
  if (bodyCloseBrace === -1) return { migrated: false, content, warnings };

  let callbackBody = content.slice(bodyOpenBrace + 1, bodyCloseBrace).trim();

  // Remove entire statements that are just .start() calls (e.g. `await appkit.server.start();`)
  callbackBody = callbackBody
    .replace(/^\s*(?:await\s+)?\w+\.server\s*\.\s*start\(\s*\)\s*;?\s*$/gm, "")
    .replace(/\n\s*\.start\(\s*\)\s*;?/g, ";")
    .replace(/\.start\(\s*\)/g, "")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();

  // Clean up trailing semicolons
  if (callbackBody.endsWith(";")) {
    // fine
  } else if (!callbackBody.endsWith("}")) {
    callbackBody += ";";
  }

  // Detect if the callback was async
  const isAsync = /^async\s/.test(thenInner.trim());

  // Check for .catch() after .then(...) using brace-aware parsing
  const afterThenClose = content.slice(thenCloseParen + 1);
  const catchPatternMatch = afterThenClose.match(/^\s*(?:\)\s*)?\.catch\s*\(/);

  let catchSuffix: string;
  let consumeAfterThen: number;

  if (catchPatternMatch) {
    const catchOpenParen = thenCloseParen + 1 + catchPatternMatch[0].length - 1;
    const catchCloseParen = findMatchingClose(content, catchOpenParen);
    if (catchCloseParen !== -1) {
      const catchArg = content
        .slice(catchOpenParen + 1, catchCloseParen)
        .trim();
      catchSuffix = `.catch(${catchArg})`;
      consumeAfterThen = catchCloseParen + 1 - (thenCloseParen + 1);
    } else {
      catchSuffix = ".catch(console.error)";
      consumeAfterThen = 0;
    }
  } else {
    catchSuffix = ".catch(console.error)";
    consumeAfterThen = 0;
  }

  // Build the onPluginsReady property
  const configStr = content.slice(configOpenParen + 1, configCloseParen);
  const lastBraceIdx = configStr.lastIndexOf("}");
  if (lastBraceIdx === -1) return { migrated: false, content, warnings };

  const beforeLastBrace = configStr.slice(0, lastBraceIdx).trimEnd();
  const needsComma = beforeLastBrace.endsWith(",") ? "" : ",";

  // Indent the body properly
  const bodyLines = callbackBody.split("\n");
  const indentedBody = bodyLines
    .map((line) => `    ${line.trimStart()}`)
    .join("\n");

  const asyncPrefix = isAsync ? "async " : "";
  const onPluginsReadyProp = `${needsComma}\n  ${asyncPrefix}onPluginsReady(${paramName}) {\n${indentedBody}\n  },`;
  const newConfig = `${beforeLastBrace}${onPluginsReadyProp}\n}`;

  // Build the replacement
  const endIdx = thenCloseParen + 1 + consumeAfterThen;
  // Consume trailing ) ; and whitespace
  let finalEnd = endIdx;
  const trailing = content.slice(finalEnd).match(/^\s*\)?\s*;?\s*/);
  if (trailing) finalEnd += trailing[0].length;

  const newContent =
    content.slice(0, createAppIdx) +
    `createApp(${newConfig})${catchSuffix};` +
    content.slice(finalEnd);

  return { migrated: true, content: newContent, warnings };
}

function migratePatternB(content: string): MigrationResult {
  const warnings: string[] = [];

  // Match: const/let varName = await createApp({...});
  const awaitPattern = /(?:const|let)\s+(\w+)\s*=\s*await\s+createApp\s*\(/;

  const match = content.match(awaitPattern);
  if (!match) return { migrated: false, content, warnings };

  const varName = match[1];
  const matchIdx = content.indexOf(match[0]);

  // Find the createApp(...) closing paren
  const configOpenParen = matchIdx + match[0].length - 1;
  const configCloseParen = findMatchingClose(content, configOpenParen);
  if (configCloseParen === -1) return { migrated: false, content, warnings };

  // Find the semicolon after the createApp call
  const afterCall = content.slice(configCloseParen + 1);
  const semiMatch = afterCall.match(/^\s*;/);
  const createAppEnd =
    configCloseParen + 1 + (semiMatch ? semiMatch[0].length : 0);

  // Find all uses of varName after the createApp call
  const afterCreateApp = content.slice(createAppEnd);
  const varUsagePattern = new RegExp(`\\b${varName}\\.(\\w+)`, "g");

  const usages: { plugin: string; index: number }[] = [];
  for (const usageMatch of afterCreateApp.matchAll(varUsagePattern)) {
    usages.push({ plugin: usageMatch[1], index: usageMatch.index });
  }

  // Check for non-server usage
  const nonServerUsage = usages.filter((u) => u.plugin !== "server");
  if (nonServerUsage.length > 0) {
    warnings.push(
      `Found additional usage of '${varName}' handle outside server.extend/start. Please migrate manually.`,
    );
    return { migrated: false, content, warnings };
  }

  // Find the extend call(s) and start call in the after-createApp region
  const extendPattern = new RegExp(
    `\\b${varName}\\.server\\.extend\\s*\\(`,
    "g",
  );
  const startPattern = new RegExp(
    `(?:await\\s+)?${varName}\\.server\\.start\\s*\\(\\s*\\)\\s*;`,
  );

  const extendMatches = [...afterCreateApp.matchAll(extendPattern)];
  if (extendMatches.length > 1) {
    warnings.push(
      `Found ${extendMatches.length} server.extend() calls. Please migrate manually.`,
    );
    return { migrated: false, content, warnings };
  }

  const extendExec = extendMatches[0] ?? null;
  const startExec = startPattern.exec(afterCreateApp);

  if (!startExec) return { migrated: false, content, warnings };

  // Extract the extend call's argument
  let extendArg = "";
  let extendFullStatement = "";
  if (extendExec) {
    const extendOpenParen =
      createAppEnd + extendExec.index + extendExec[0].length - 1;
    const extendCloseParen = findMatchingClose(content, extendOpenParen);
    if (extendCloseParen !== -1) {
      extendArg = content.slice(extendOpenParen + 1, extendCloseParen).trim();
      // Find the full statement including trailing semicolon
      const stmtStart = createAppEnd + extendExec.index;
      let stmtEnd = extendCloseParen + 1;
      const afterExtend = content.slice(stmtEnd);
      const trailingSemi = afterExtend.match(/^\s*;/);
      if (trailingSemi) stmtEnd += trailingSemi[0].length;
      extendFullStatement = content.slice(stmtStart, stmtEnd);
    }
  }

  const startFullStatement = startExec[0];

  // Build the onPluginsReady callback
  const configStr = content.slice(configOpenParen + 1, configCloseParen);
  const lastBraceIdx = configStr.lastIndexOf("}");
  if (lastBraceIdx === -1) return { migrated: false, content, warnings };

  const beforeLastBrace = configStr.slice(0, lastBraceIdx).trimEnd();
  const needsComma = beforeLastBrace.endsWith(",") ? "" : ",";

  let onPluginsReadyProp: string;
  if (extendArg) {
    onPluginsReadyProp =
      `${needsComma}\n  onPluginsReady(${varName}) {\n` +
      `    ${varName}.server.extend(${extendArg});\n` +
      "  },";
  } else {
    onPluginsReadyProp = "";
  }

  const newConfig = `${beforeLastBrace}${onPluginsReadyProp}\n}`;
  const newCreateApp = `await createApp(${newConfig});`;

  // Replace: remove const declaration, replace with plain await, remove extend + start
  let result = content.slice(0, matchIdx) + newCreateApp;
  let remaining = afterCreateApp;

  if (extendFullStatement) {
    remaining = remaining.replace(extendFullStatement, "");
  }
  remaining = remaining.replace(startFullStatement, "");

  // Clean up consecutive blank lines
  remaining = remaining.replace(/\n\s*\n\s*\n/g, "\n\n");

  result += remaining;

  return { migrated: true, content: result, warnings };
}

export function migrateFile(filePath: string): MigrationResult {
  const original = fs.readFileSync(filePath, "utf-8");

  if (isAlreadyMigrated(original)) {
    return {
      migrated: false,
      content: original,
      warnings: ["Already migrated -- no changes needed."],
    };
  }

  const content = stripAutoStartFromServerCalls(original);
  const allWarnings: string[] = [];

  // Try Pattern A first
  const patternA = migratePatternA(content);
  if (patternA.migrated) {
    allWarnings.push(...patternA.warnings);
    return {
      migrated: true,
      content: patternA.content,
      warnings: allWarnings,
    };
  }
  allWarnings.push(...patternA.warnings);

  // Try Pattern B
  const patternB = migratePatternB(content);
  if (patternB.migrated) {
    allWarnings.push(...patternB.warnings);
    return {
      migrated: true,
      content: patternB.content,
      warnings: allWarnings,
    };
  }
  allWarnings.push(...patternB.warnings);

  // Check if autoStart was stripped (content changed but no pattern matched)
  if (content !== original) {
    return { migrated: true, content, warnings: allWarnings };
  }

  return { migrated: false, content: original, warnings: allWarnings };
}

function runCodemod(options: { path?: string; write?: boolean }) {
  const rootDir = process.cwd();
  const write = options.write ?? false;

  let files: string[];
  if (options.path) {
    const absPath = path.resolve(rootDir, options.path);
    if (!fs.existsSync(absPath)) {
      console.error(`File not found: ${absPath}`);
      process.exit(1);
    }
    files = [absPath];
  } else {
    files = findServerEntryFiles(rootDir);
  }

  if (files.length === 0) {
    console.log("No files found importing createApp from @databricks/appkit.");
    console.log("Use --path to specify a file explicitly.");
    process.exit(0);
  }

  let hasChanges = false;

  for (const file of files) {
    const relPath = path.relative(rootDir, file);
    const result = migrateFile(file);

    for (const warning of result.warnings) {
      console.log(`  ${relPath}: ${warning}`);
    }

    if (!result.migrated) {
      if (result.warnings.length === 0) {
        console.log(`  ${relPath}: No migration needed.`);
      }
      continue;
    }

    hasChanges = true;

    if (write) {
      fs.writeFileSync(file, result.content, "utf-8");
      console.log(`  ${relPath}: Migrated successfully.`);
    } else {
      console.log(`\n--- ${relPath} (dry run) ---`);
      console.log(result.content);
      console.log("---");
    }
  }

  if (hasChanges && !write) {
    console.log("\nDry run complete. Run with --write to apply changes.");
  }
}

export const onPluginsReadyCommand = new Command("on-plugins-ready")
  .description(
    "Migrate createApp usage from autoStart/extend/start pattern to onPluginsReady callback",
  )
  .option("--path <file>", "Path to the server entry file to migrate")
  .option("--write", "Apply changes (default: dry-run)", false)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit codemod on-plugins-ready                    # dry-run, auto-detect files
  $ appkit codemod on-plugins-ready --write            # apply changes
  $ appkit codemod on-plugins-ready --path server.ts   # migrate a specific file`,
  )
  .action(runCodemod);

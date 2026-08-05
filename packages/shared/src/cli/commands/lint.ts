import fs from "node:fs";
import path from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { Command } from "commander";

interface BaseRule {
  id: string;
  message: string;
  includeTests?: boolean;
  filter?: (code: string) => boolean;
}

/**
 * A rule matches via exactly one of `pattern` (an ast-grep pattern for
 * `root.findAll`) or `find` (an escape hatch for checks a single pattern can't
 * express). Discriminated union so a rule with neither or both fails to compile.
 */
type Rule =
  | (BaseRule & { pattern: string; find?: never })
  | (BaseRule & { find: (root: SgNode) => SgNode[]; pattern?: never });

/** Value node of an object literal's `key: value` pair, or undefined. */
function objectPropertyValue(obj: SgNode, key: string): SgNode | undefined {
  for (const pair of obj.children()) {
    if (pair.kind() !== "pair") continue;
    const k = pair.field("key");
    // Strip quotes so `columns` and `"columns"` are treated the same.
    if (k && k.text().replace(/^["']|["']$/g, "") === key) {
      return pair.field("value") ?? undefined;
    }
  }
  return undefined;
}

/** True for `[]` / `[ ]` — an array literal with no elements. */
function isEmptyArrayLiteral(node: SgNode): boolean {
  return node.kind() === "array" && node.children().every((c) => !c.isNamed());
}

/**
 * Flags `aiSearch(...)` configs whose indexes lack usable `columns`. Production
 * does not auto-discover columns (dev-only), so a missing or empty `columns`
 * fails at query time. Passes anything it can't statically prove bad (constant
 * or dynamically-built columns/indexes) to avoid false positives.
 */
function findAiSearchIndexesMissingColumns(root: SgNode): SgNode[] {
  const flagged: SgNode[] = [];

  for (const call of root.findAll("aiSearch($$$ARGS)")) {
    const argNodes =
      call
        .field("arguments")
        ?.children()
        .filter((c) => c.isNamed()) ?? [];

    // Bare aiSearch(): relies on the env default index (no columns).
    if (argNodes.length === 0) {
      flagged.push(call);
      continue;
    }

    // aiSearch(dynamicConfig) — not an object literal, can't inspect. Pass.
    const configObj = argNodes[0].kind() === "object" ? argNodes[0] : undefined;
    if (!configObj) continue;

    const indexes = objectPropertyValue(configObj, "indexes");

    // No `indexes` key => falls back to the env default index (no columns).
    if (!indexes) {
      flagged.push(call);
      continue;
    }
    if (indexes.kind() !== "object") continue; // dynamic indexes: pass.

    const indexPairs = indexes.children().filter((c) => c.kind() === "pair");

    // Empty `indexes: {}` => no configured index, same as bare.
    if (indexPairs.length === 0) {
      flagged.push(call);
      continue;
    }

    for (const pair of indexPairs) {
      const idxObj = pair.field("value");
      if (!idxObj || idxObj.kind() !== "object") continue; // dynamic: pass.
      // A spread (`{ ...base }`) may carry `columns` we can't see: pass.
      if (idxObj.children().some((c) => c.kind() === "spread_element"))
        continue;
      const columns = objectPropertyValue(idxObj, "columns");
      if (!columns || isEmptyArrayLiteral(columns)) {
        flagged.push(pair); // points at the offending index alias.
      }
    }
  }

  return flagged;
}

const rules: Rule[] = [
  {
    id: "no-double-type-assertion",
    pattern: "$X as unknown as $Y",
    message:
      "Avoid double type assertion (as unknown as). Use proper type guards or fix the source type.",
  },
  {
    id: "no-as-any",
    pattern: "$X as any",
    message:
      'Avoid "as any" type assertion. Use proper typing or unknown with type guards.',
    includeTests: false, // acceptable in test mocks
  },
  {
    id: "no-array-index-key",
    pattern: "key={$IDX}",
    message:
      "Avoid using array index as React key. Use a stable unique identifier.",
    filter: (code) => /key=\{(idx|index|i)\}/.test(code),
  },
  {
    id: "no-parse-float-without-validation",
    pattern: "parseFloat($X).toFixed($Y)",
    message:
      "parseFloat can return NaN. Validate input or use toNumber() helper from shared/types.ts.",
  },
  {
    // <Variants> is the dev-only variant picker from @databricks/appkit-ui,
    // meant to drive the local edit loop. Finalize the chosen variant before
    // deploying so the picker chrome never reaches production.
    id: "no-variants-in-prod",
    pattern: "<Variants $$$P>$$$C</Variants>",
    message:
      "<Variants> is a development-only variant picker and must not be shipped. Finalize the chosen <Variant> before deploying.",
    includeTests: false,
  },
  {
    id: "ai-search-index-requires-columns",
    message:
      "AI Search index has no `columns`; it will fail in production (columns are auto-discovered only in dev). Set `columns` explicitly on each index.",
    includeTests: false,
    find: findAiSearchIndexesMissingColumns,
  },
];

function isTestFile(filePath: string, rootDir: string): boolean {
  // Relative to scan root: an ancestor `tests` dir must not mark the whole project as tests.
  const rel = path.relative(rootDir, filePath);
  return (
    /\.(test|spec)\.(ts|tsx)$/.test(rel) || /(^|[/\\])tests[/\\]/.test(rel)
  );
}

function findTsFiles(dir: string, files: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (["node_modules", "dist", "build", ".git"].includes(entry.name))
        continue;
      findTsFiles(fullPath, files);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

interface Violation {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
  code: string;
}

/**
 * Runs all applicable rules against a file's source. Exported so tests can lint
 * an in-memory string without touching disk.
 */
export function lintSource(
  content: string,
  filePath: string,
  activeRules: Rule[] = rules,
  isTest = false,
): Violation[] {
  const violations: Violation[] = [];
  const lang = filePath.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript;
  const root = parse(lang, content).root();

  for (const rule of activeRules) {
    // skip rules that don't apply to test files
    if (isTest && rule.includeTests === false) continue;

    const matches = rule.find ? rule.find(root) : root.findAll(rule.pattern);

    for (const match of matches) {
      const code = match.text();

      if (rule.filter && !rule.filter(code)) continue;

      const range = match.range();
      violations.push({
        file: filePath,
        line: range.start.line + 1,
        column: range.start.column + 1,
        rule: rule.id,
        message: rule.message,
        code: code.length > 80 ? `${code.slice(0, 77)}...` : code,
      });
    }
  }

  return violations;
}

function lintFile(
  filePath: string,
  activeRules: Rule[],
  rootDir: string,
): Violation[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return lintSource(
    content,
    filePath,
    activeRules,
    isTestFile(filePath, rootDir),
  );
}

/**
 * Lint command implementation
 */
function runLint() {
  const rootDir = process.cwd();
  const files = findTsFiles(rootDir);

  console.log(`Scanning ${files.length} TypeScript files...\n`);

  const allViolations: Violation[] = [];

  for (const file of files) {
    const violations = lintFile(file, rules, rootDir);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log("No ast-grep lint violations found.");
    process.exit(0);
  }

  console.log(`Found ${allViolations.length} violation(s):\n`);

  for (const v of allViolations) {
    const relPath = path.relative(rootDir, v.file);
    console.log(`${relPath}:${v.line}:${v.column}`);
    console.log(`  ${v.rule}: ${v.message}`);
    console.log(`  > ${v.code}\n`);
  }

  process.exit(1);
}

export const lintCommand = new Command("lint")
  .description("Run AST-based linting on TypeScript files")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit lint`,
  )
  .action(runLint);

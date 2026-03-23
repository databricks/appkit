import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createLogger } from "../../logging/logger";

const logger = createLogger("devtools:source-map");

export interface ComponentLocation {
  file: string;
  line: number;
  exportName: string;
}

const COMPONENT_PATTERNS = [
  /export\s+(?:default\s+)?function\s+([A-Z]\w+)/g,
  /export\s+const\s+([A-Z]\w+)\s*[=:]/g,
  /(?:const|let|var)\s+([A-Z]\w+)\s*=\s*(?:React\.)?(?:memo|forwardRef|lazy)\(/g,
  /function\s+([A-Z]\w+)\s*\(/g,
];

const EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".next",
  ".vite",
  "__pycache__",
]);

function walkDir(dir: string, files: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath, files);
      } else if (stat.isFile()) {
        const ext = entry.slice(entry.lastIndexOf("."));
        if (EXTENSIONS.has(ext)) files.push(fullPath);
      }
    } catch {}
  }
}

function scanFile(filePath: string): Map<string, number> {
  const results = new Map<string, number>();
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return results;
  }

  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of COMPONENT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const name = match[1];
        if (!results.has(name)) {
          results.set(name, i + 1);
        }
      }
    }
  }

  return results;
}

let cachedMap: Map<string, ComponentLocation> | null = null;
let cachedRoot: string | null = null;

export function buildComponentMap(
  rootDir: string,
): Map<string, ComponentLocation> {
  if (cachedMap && cachedRoot === rootDir) return cachedMap;

  logger.info("Scanning %s for React components…", rootDir);
  const startedAt = Date.now();

  const files: string[] = [];
  walkDir(rootDir, files);

  const componentMap = new Map<string, ComponentLocation>();

  for (const filePath of files) {
    const components = scanFile(filePath);
    const relPath = relative(rootDir, filePath);
    for (const [name, line] of components) {
      if (!componentMap.has(name)) {
        componentMap.set(name, { file: relPath, line, exportName: name });
      }
    }
  }

  cachedMap = componentMap;
  cachedRoot = rootDir;

  logger.info(
    "Found %d components in %d files (%dms)",
    componentMap.size,
    files.length,
    Date.now() - startedAt,
  );

  return componentMap;
}

export function invalidateComponentMap() {
  cachedMap = null;
  cachedRoot = null;
}

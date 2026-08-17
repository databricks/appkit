import fs from "node:fs";
import path from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { JS_IDENTIFIER } from "./constants";

/** Server entry candidates within the server root, in priority order. */
const SERVER_FILE_CANDIDATES = [
  "server.ts",
  "index.ts",
  "src/server.ts",
  "src/index.ts",
];

export interface RegisterResult {
  /** wired = edited; already = plugin was present; skipped = couldn't safely edit. */
  status: "wired" | "already" | "skipped";
  file?: string;
  reason?: string;
}

function findServerFile(serverRoot: string): string | null {
  for (const candidate of SERVER_FILE_CANDIDATES) {
    const p = path.join(serverRoot, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The `plugins: [...]` array node inside a createApp call, if present. */
function findPluginsArray(root: SgNode): SgNode | null {
  for (const pair of root.findAll({ rule: { kind: "pair" } })) {
    const key = pair.find({ rule: { kind: "property_identifier" } });
    if (key?.text() !== "plugins") continue;
    const arr = pair.find({ rule: { kind: "array" } });
    if (arr) return arr;
  }
  return null;
}

function arrayElementNames(arr: SgNode): Set<string> {
  const names = new Set<string>();
  for (const child of arr.children()) {
    if (child.kind() === "identifier") {
      names.add(child.text());
    } else if (child.kind() === "call_expression") {
      const callee = child.children()[0];
      if (callee?.kind() === "identifier") names.add(callee.text());
    }
  }
  return names;
}

/** Local binding names introduced by an import statement — default, namespace,
 * and named specifiers, with aliases resolved to the local name. */
function importBindingNames(stmt: SgNode): Set<string> {
  const names = new Set<string>();
  const clause = stmt.find({ rule: { kind: "import_clause" } });
  if (!clause) return names;
  for (const child of clause.children()) {
    const kind = child.kind();
    if (kind === "identifier") {
      names.add(child.text());
    } else if (kind === "namespace_import") {
      const id = child.find({ rule: { kind: "identifier" } });
      if (id) names.add(id.text());
    } else if (kind === "named_imports") {
      for (const spec of child.findAll({
        rule: { kind: "import_specifier" },
      })) {
        const local = spec.field("alias")?.text() ?? spec.field("name")?.text();
        if (local) names.add(local);
      }
    }
  }
  return names;
}

/**
 * Best-effort: register a plugin in the server entry's `createApp({ plugins })`
 * call by inserting the import and adding it to the array. Only edits the
 * standard shape (a `plugins: [...]` array literal); returns `skipped` otherwise
 * so the caller can fall back to printing manual instructions. Idempotent.
 */
export function registerPluginInServer(
  serverRoot: string,
  importPath: string,
  exportName: string,
): RegisterResult {
  // exportName and importPath are interpolated into the user's server source.
  // Registry items are untrusted, so refuse anything that isn't a plain JS
  // identifier / clean relative module path — prevents code injection via a
  // crafted export name or import path.
  if (!JS_IDENTIFIER.test(exportName)) {
    return { status: "skipped", reason: "invalid plugin export name" };
  }
  if (!/^[.][./A-Za-z0-9_-]*$/.test(importPath)) {
    return { status: "skipped", reason: "invalid plugin import path" };
  }

  const serverFile = findServerFile(serverRoot);
  if (!serverFile) {
    return { status: "skipped", reason: "no server entry file found" };
  }

  const content = fs.readFileSync(serverFile, "utf-8");
  const lang = serverFile.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript;
  const root = parse(lang, content).root();

  const arr = findPluginsArray(root);
  if (!arr) {
    return {
      status: "skipped",
      reason: "no createApp({ plugins: [...] }) array found",
    };
  }

  const file = path.relative(serverRoot, serverFile);
  if (arrayElementNames(arr).has(exportName)) {
    return { status: "already", file };
  }

  const edits = [];

  // toPlugin exports are factories, registered as a call: `hello()`.
  const newElem = `${exportName}()`;

  // Insert before the first element, matching its indentation so the array
  // formatting is preserved (or inline for a single-line array).
  const elementKinds = ["identifier", "call_expression", "spread_element"];
  const firstEl = arr
    .children()
    .find((c) => elementKinds.includes(c.kind() as string));
  if (!firstEl) {
    edits.push(arr.replace(`[${newElem}]`));
  } else {
    const startIdx = firstEl.range().start.index;
    const lineStart = content.lastIndexOf("\n", startIdx - 1);
    const indent = content.slice(lineStart + 1, startIdx);
    const multiline = lineStart !== -1 && /^[ \t]*$/.test(indent);
    const sep = multiline ? `,\n${indent}` : ", ";
    edits.push(firstEl.replace(`${newElem}${sep}${firstEl.text()}`));
  }

  // Add the import unless `exportName` is already bound by some import. De-dup
  // on the binding, not the module path: an existing import from the same path
  // under a different name (e.g. `import { HelloPlugin } from "./plugins/hello"`)
  // must not suppress this one, or the `${exportName}()` element just added to
  // the array would reference an unimported symbol and the server won't compile.
  const importStmts = root.findAll({ rule: { kind: "import_statement" } });
  const hasBinding = importStmts.some((s) =>
    importBindingNames(s).has(exportName),
  );
  const importLine = `import { ${exportName} } from "${importPath}";`;
  if (!hasBinding && importStmts.length > 0) {
    const last = importStmts[importStmts.length - 1];
    edits.push(last.replace(`${last.text()}\n${importLine}`));
  }

  let output = root.commitEdits(edits);
  if (!hasBinding && importStmts.length === 0) {
    output = `${importLine}\n${output}`;
  }
  fs.writeFileSync(serverFile, output);

  return { status: "wired", file };
}

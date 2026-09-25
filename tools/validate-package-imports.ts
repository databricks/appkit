import fs from "node:fs";
import path from "node:path";

import { Lang, parse } from "@ast-grep/napi";

function findJavaScriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(file);
    return /\.[cm]?js$/.test(entry.name) ? [file] : [];
  });
}

function relativeImports(source: string): string[] {
  const root = parse(Lang.JavaScript, source).root();
  const imports = root
    .findAll({
      rule: {
        any: [{ kind: "import_statement" }, { kind: "export_statement" }],
      },
    })
    .map((node) => node.field("source")?.text())
    .filter((value): value is string => Boolean(value));

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    if (call.field("function")?.text() !== "import") continue;
    const argument = call
      .field("arguments")
      ?.children()
      .find((node) => node.kind() === "string");
    if (argument) imports.push(argument.text());
  }

  return imports
    .map((value) => value.slice(1, -1))
    .filter((value) => value.startsWith("."));
}

/** Fail packaging when a built JavaScript module has a missing relative import. */
export function assertPackageImportsResolve(dir: string): void {
  const missing = findJavaScriptFiles(dir).flatMap((file) =>
    relativeImports(fs.readFileSync(file, "utf8"))
      .map((specifier) => ({
        file,
        specifier,
        target: path.resolve(path.dirname(file), specifier),
      }))
      .filter(({ target }) => !fs.existsSync(target)),
  );

  if (missing.length) {
    throw new Error(
      `Package contains missing relative imports:\n${missing
        .map(({ file, specifier }) => `- ${file} -> ${specifier}`)
        .join("\n")}`,
    );
  }
}

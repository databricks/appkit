import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COLLAPSED_MARKER = "[collapsed]";

interface Section {
  name: string;
  body: string;
  collapsed: boolean;
}

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

function parseSections(content: string): {
  header: string;
  sections: Section[];
} {
  const parts = content.split(/^(## .+)$/m);
  const header = parts[0];
  const sections: Section[] = [];

  for (let i = 1; i < parts.length; i += 2) {
    const rawName = parts[i].replace(/^## /, "");
    const body = parts[i + 1] ?? "";
    const collapsed = rawName.includes(COLLAPSED_MARKER);
    const name = rawName.replace(COLLAPSED_MARKER, "").trim();
    sections.push({ name, body, collapsed });
  }

  return { header, sections };
}

function countPages(body: string): number {
  return (body.match(/^- \[/gm) || []).length;
}

function findSections(sections: Section[], query: string): Section[] {
  const q = query.toLowerCase();
  return sections.filter((s) => s.name.toLowerCase().includes(q));
}

function isFilePath(arg: string): boolean {
  return arg.startsWith("./") && arg.endsWith(".md");
}

function readLlmsTxt(packageRoot: string): string {
  const llmsPath = path.join(packageRoot, "llms.txt");
  if (!fs.existsSync(llmsPath)) {
    console.error("Error: llms.txt not found in package");
    process.exit(1);
  }
  return fs.readFileSync(llmsPath, "utf-8");
}

function readDocFile(packageRoot: string, docPath: string): void {
  let normalizedPath = docPath;
  normalizedPath = normalizedPath.replace(/^\.\//, "");
  normalizedPath = normalizedPath.replace(/^\//, "");
  normalizedPath = normalizedPath.replace(/^appkit\//, "");

  const fullPath = path.join(packageRoot, normalizedPath);

  if (!fs.existsSync(fullPath)) {
    console.error(`Error: Documentation file not found: ${docPath}`);
    console.error(`Tried: ${fullPath}`);
    process.exit(1);
  }

  console.log(fs.readFileSync(fullPath, "utf-8"));
}

function formatCollapsedSection(section: Section): string {
  const pages = countPages(section.body);
  return [
    `## ${section.name} (${pages} pages)`,
    "",
    `> Use \`appkit docs "${section.name}"\` to expand, or \`appkit docs --full\` to expand all sections.`,
    "",
  ].join("\n");
}

function formatExpandedSection(section: Section): string {
  return `## ${section.name}${section.body}`;
}

function runDocs(query: string | undefined, options: { full?: boolean }) {
  const packageRoot = findPackageRoot();

  if (query && isFilePath(query)) {
    readDocFile(packageRoot, query);
    return;
  }

  const content = readLlmsTxt(packageRoot);

  if (options.full) {
    console.log(content.replaceAll(` ${COLLAPSED_MARKER}`, ""));
    return;
  }

  const { header, sections } = parseSections(content);

  if (query) {
    const matched = findSections(sections, query);
    if (matched.length === 0) {
      const available = sections.map((s) => `  - ${s.name}`).join("\n");
      console.error(
        `No section matching "${query}". Available sections:\n${available}`,
      );
      process.exit(1);
    }
    console.log(matched.map(formatExpandedSection).join("\n"));
    return;
  }

  const output =
    header +
    sections
      .map((s) =>
        s.collapsed ? formatCollapsedSection(s) : formatExpandedSection(s),
      )
      .join("\n");
  console.log(output);
}

export const docsCommand = new Command("docs")
  .description("Display embedded documentation")
  .argument(
    "[query]",
    "Section name (e.g. 'plugins') or path to a doc file (e.g. './docs.md')",
  )
  .option("--full", "Show complete index including all API reference entries")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit docs
  $ appkit docs plugins
  $ appkit docs "appkit-ui API reference"
  $ appkit docs ./docs/plugins/analytics.md
  $ appkit docs --full`,
  )
  .action(runDocs);

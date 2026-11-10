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

interface ApiEntry {
  file: string;
  line: number;
  level: number;
}

/** Headings in component pages that name a page part, not an API. */
const PAGE_PARTS = new Set(["Example", "Examples", "Props", "Usage", "Source"]);
/** Prose this long that another name already printed is left out of a multi-name lookup. */
const LONG_PROSE = 100;
/** Sections a multi-name lookup leaves out: the signatures and props already say what they say. */
const DETAIL_SECTIONS = /^(Example|Examples|Parameters|Returns|Usage|Source)\b/;

/** The exported docs carry each heading's anchor link (`## Props[​](#props "Direct link to Props")`). */
function cleanLine(line: string): string {
  return line.replace(/\[\u200b\]\(#[^\s)]*(?: "[^"]*")?\)/g, "").trimEnd();
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf-8").split("\n").map(cleanLine);
}

function markdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.name.endsWith(".md") ? [file] : [];
  });
}

/**
 * Every documented name: component pages and their parts (`docs/api/appkit-ui/<group>/<Name>.md`, `## SelectItem`),
 * reference pages (`docs/api/appkit/<Kind>.<name>.md`), and hooks documented in guides (`### useAnalyticsQuery`).
 */
export function apiIndex(packageRoot: string): Map<string, ApiEntry> {
  const docsDir = path.join(packageRoot, "docs");
  const index = new Map<string, ApiEntry>();
  const add = (name: string, entry: ApiEntry) => {
    if (!index.has(name)) index.set(name, entry);
  };
  for (const file of markdownFiles(docsDir)) {
    const rel = path.relative(docsDir, file).split(path.sep).join("/");
    const reference = rel.match(/^api\/appkit\/[A-Za-z]+\.(\w+)\.md$/);
    if (reference) {
      add(reference[1], { file, line: 0, level: 1 });
      continue;
    }
    const componentPage = rel.startsWith("api/appkit-ui/");
    readLines(file).forEach((line, i) => {
      const heading = line.match(/^(#{1,4}) `?([A-Za-z]\w*)`?$/);
      if (!heading || PAGE_PARTS.has(heading[2])) return;
      if (componentPage || /^use[A-Z]/.test(heading[2])) {
        add(heading[2], { file, line: i, level: heading[1].length });
      }
    });
  }
  return index;
}

const unescapeCell = (cell: string) =>
  cell
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|])/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/`/g, "");

function tableCells(row: string): string[] {
  return row
    .replace(/^\|\s*|\s*\|$/g, "")
    .split(/\s*(?<!\\)\|\s*/)
    .map(unescapeCell);
}

/** A prop description's first sentence; the next one starts with a capital, a backtick or a parenthesis. */
const firstSentence = (text: string) =>
  text.replace(/^(.+?\.)\s+[A-Z`(].*$/, "$1");

/**
 * A doc section as an agent reads it: prose and signatures, one line per prop, no table chrome. A multi-name
 * lookup (`details` off) also drops examples and prints a prop that an earlier name already showed only by name.
 */
function condense(
  lines: string[],
  details: boolean,
  printed: Map<string, string>,
  owner: string,
): string {
  const out: string[] = [];
  const repeated = new Map<string, string[]>();
  let inCode = false;
  let skipLevel = 0;
  let propsTable = false;
  for (const [i, line] of lines.entries()) {
    const heading = !inCode && line.match(/^(#+) (.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (skipLevel && level > skipLevel) continue;
      skipLevel =
        /^(Usage|Source)\b/.test(heading[2]) ||
        (!details && DETAIL_SECTIONS.test(heading[2]))
          ? level
          : 0;
      if (!skipLevel && heading[2] !== "Props") out.push(line);
      continue;
    }
    if (skipLevel) continue;
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode || line.startsWith("```")) {
      out.push(line);
      continue;
    }
    if (/^<!--|^\*\*Source:\*\*/.test(line)) continue;
    if (line.startsWith("|")) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      if (/^\|[\s:|-]+\|$/.test(lines[i + 1] ?? "")) {
        propsTable = /^\|\s*Prop\s*\|/.test(line);
        continue;
      }
      const cells = tableCells(line);
      if (propsTable && cells.length === 5) {
        const [name, type, required, def, desc] = cells;
        const optional = required ? "" : "?";
        const value = def && def !== "-" ? ` = ${def}` : "";
        const note =
          desc && desc !== "-"
            ? ` — ${details ? desc : firstSentence(desc)}`
            : "";
        const prop = `- ${name}${optional}: ${type}${value}${note}`;
        const earlier = details ? undefined : printed.get(prop);
        if (earlier) {
          repeated.set(earlier, [...(repeated.get(earlier) ?? []), name]);
          continue;
        }
        printed.set(prop, owner);
        out.push(prop);
      } else {
        out.push(`- ${cells.join(" | ")}`);
      }
      continue;
    }
    // A description repeats under a page's title and its own section, and a long note across pages (the
    // charts'); a short line said by another name is cheap and may be all that name has.
    const earlier = printed.get(line);
    if (
      line.trim() &&
      (earlier === owner || (earlier && line.length >= LONG_PROSE))
    )
      continue;
    printed.set(line, owner);
    if (line.trim() || (out.length && out[out.length - 1].trim()))
      out.push(line);
  }
  for (const [earlier, props] of repeated) {
    out.push(`- ${props.join(", ")}: as in ${earlier}`);
  }
  return out.join("\n").trim();
}

function sectionLines(entry: ApiEntry): string[] {
  const lines = readLines(entry.file);
  let end = entry.line + 1;
  while (end < lines.length) {
    const heading = lines[end].match(/^(#+) /);
    if (heading && heading[1].length <= entry.level) break;
    end++;
  }
  return lines.slice(entry.line, end);
}

/** Names close to an unknown one: those sharing a word with it (DateRangePicker: date, range, picker). */
function similarNames(index: Map<string, ApiEntry>, name: string): string[] {
  const words = name
    .split(/(?=[A-Z])|[^A-Za-z]/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2);
  const hits = (text: string) =>
    words.filter((w) => text.toLowerCase().includes(w)).length;
  // A component's description names what it does ("Date picker component" for Calendar); reference pages'
  // descriptions are too generic to match on.
  const score = (candidate: string, entry: ApiEntry) =>
    2 * hits(candidate) +
    (entry.file.includes(`${path.sep}appkit-ui${path.sep}`)
      ? hits(description(entry))
      : 0);
  const scores = new Map(
    [...index].map(([candidate, entry]) => [
      candidate,
      score(candidate, entry),
    ]),
  );
  return [...scores.keys()]
    .filter((candidate) => (scores.get(candidate) ?? 0) > 0)
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    .slice(0, 6);
}

/** The first line of prose under an entry's heading. */
function description(entry: ApiEntry): string {
  const lines = readLines(entry.file);
  for (let i = entry.line + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#/.test(line)) return "";
    if (line && !/^(```|\||<!--|\*\*Source)/.test(line)) return line;
  }
  return "";
}

export function lookupNames(packageRoot: string, names: string[]): string {
  const index = apiIndex(packageRoot);
  const details = names.length === 1;
  const printed = new Map<string, string>();
  return names
    .map((name) => {
      const entry = index.get(name);
      if (!entry) {
        const similar = similarNames(index, name);
        return `=== ${name}\nNot documented.${similar.length ? ` Similar: ${similar.join(", ")}` : ""}`;
      }
      let lines = sectionLines(entry);
      // A reference page (`Variable.sql.md`) details every member; a multi-name lookup keeps the declaration.
      const reference = path
        .relative(packageRoot, entry.file)
        .startsWith(path.join("docs", "api", "appkit") + path.sep);
      if (reference && !details) {
        const end = lines.findIndex(
          (line, i) => i > 0 && line.startsWith("## "),
        );
        const members = lines
          .filter((line) => line.startsWith("### "))
          .map((line) => line.slice(4));
        lines = lines.slice(0, end < 0 ? lines.length : end);
        if (members.length)
          lines.push(
            "",
            `Members: ${members.join(", ")} (\`appkit docs ${name}\` for each)`,
          );
      }
      const source = path.relative(packageRoot, entry.file);
      return `=== ${name} (${source})\n${condense(lines, details, printed, name)}`;
    })
    .join("\n\n");
}

function runDocs(queries: string[], options: { full?: boolean }) {
  const packageRoot = findPackageRoot();
  const [query] = queries;

  if (query && isFilePath(query)) {
    readDocFile(packageRoot, query);
    return;
  }

  // Names may come as separate arguments or as one ("BarChart DataTable"); a section name has spaces too, so a
  // single argument is a list of names only when each of its words is one.
  const names = queries.flatMap((q) => q.split(/[\s,]+/)).filter(Boolean);
  if (names.length) {
    const index = apiIndex(packageRoot);
    if (queries.length > 1 || names.every((name) => index.has(name))) {
      console.log(lookupNames(packageRoot, names));
      return;
    }
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
    "[query...]",
    "Section name (e.g. 'plugins'), path to a doc file (e.g. './docs.md'), or API names (e.g. BarChart DataTable sql)",
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
  $ appkit docs BarChart DataTable Select useAnalyticsQuery sql
  $ appkit docs --full`,
  )
  .action(runDocs);

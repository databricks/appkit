import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COLLAPSED_MARKER = "[collapsed]";

export interface Section {
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

type PageKind = "component" | "reference" | "guide";

interface ApiEntry {
  kind: PageKind;
  file: string;
  line: number;
  level: number;
}

type Printed = Map<string, string>;

// Component pages (tools/generate-component-mdx.ts) put each component's sections under Example, Usage and Props
// headings; TypeDoc's reference pages put theirs under Examples.
const EXAMPLE_HEADINGS = new Set(["Example", "Examples"]);
const COMPONENT_PAGE_HEADINGS = new Set([
  ...EXAMPLE_HEADINGS,
  "Usage",
  "Props",
]);
// Code fences, table rows, comments and the generator's source link.
const NOT_PROSE = /^(```|\||<!--|\*\*Source:\*\*)/;

/** The exported docs carry each heading's anchor link (`## Props[​](#props "Direct link to Props")`). */
function cleanLine(line: string): string {
  return line.replace(/\[\u200b\]\(#[^\s)]*(?: "[^"]*")?\)/g, "").trimEnd();
}

/** A doc line, and whether it is code (a fence or inside one), where `#` starts no heading. */
interface Line {
  text: string;
  code: boolean;
}

const linesByFile = new Map<string, Line[]>();
function linesOf(file: string): Line[] {
  let lines = linesByFile.get(file);
  if (!lines) {
    let inCode = false;
    lines = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .map((raw) => {
        const fence = raw.startsWith("```");
        if (fence) inCode = !inCode;
        return { text: cleanLine(raw), code: fence || inCode };
      });
    linesByFile.set(file, lines);
  }
  return lines;
}

const headingOf = (line: Line) =>
  line.code ? null : line.text.match(/^(#+) (.*)$/);

function markdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return markdownFiles(file);
      return entry.name.endsWith(".md") ? [file] : [];
    });
}

/**
 * Every documented name: component pages and their parts (`api/appkit-ui/<group>/<Name>.md`, `## SelectItem`),
 * reference pages (`api/appkit/<Kind>.<name>.md`), and hooks documented in guides (`### useAnalyticsQuery`).
 */
function apiIndex(packageRoot: string): Map<string, ApiEntry> {
  const docsDir = path.join(packageRoot, "docs");
  const index = new Map<string, ApiEntry>();
  for (const file of markdownFiles(docsDir)) {
    const rel = path.relative(docsDir, file).split(path.sep).join("/");
    const reference = rel.match(/^api\/appkit\/[A-Za-z]+\.(\w+)\.md$/);
    const kind: PageKind = reference
      ? "reference"
      : /^api\/appkit-ui\/[^/]+\/[^/]+\.md$/.test(rel)
        ? "component"
        : "guide";
    const add = (name: string, line: number, level: number) => {
      if (!index.has(name)) index.set(name, { kind, file, line, level });
    };
    if (reference) {
      add(reference[1], 0, 1);
      continue;
    }
    linesOf(file).forEach((line, i) => {
      const heading =
        !line.code && line.text.match(/^(#{1,4}) `?([A-Za-z]\w*)`?$/);
      if (!heading) return;
      const [, hashes, name] = heading;
      const isApi =
        kind === "component"
          ? !COMPONENT_PAGE_HEADINGS.has(name)
          : /^use[A-Z]/.test(name);
      if (isApi) add(name, i, hashes.length);
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

// The props table buildPropsSection (tools/generate-component-mdx.ts) writes: Prop | Type | Required (✓) | Default
// (- for none) | Description, with its escapes undone.
function tableCells(row: string): string[] {
  return row
    .replace(/^\|\s*|\s*\|$/g, "")
    .split(/\s*(?<!\\)\|\s*/)
    .map(unescapeCell);
}

/** A description's summary sentence (the TSDoc convention). */
const firstSentence = (text: string) =>
  text.replace(/^(.+?\.)\s+[A-Z`(].*$/, "$1");

/**
 * A doc section as an agent reads it: prose and signatures, one line per prop. Without `details` (several names),
 * no examples and props get their summary sentence. Component pages repeat their description and share notes and
 * props across pages, so on them what has been printed is referred back to instead.
 */
function condense(
  lines: Line[],
  kind: PageKind,
  owner: string,
  details: boolean,
  printed: Printed,
): string {
  const out: string[] = [];
  let lastText = "";
  let intro = "";
  const push = (text: string) => {
    out.push(text);
    if (text.trim()) lastText = text;
  };
  const sharedProps = new Map<string, string[]>();
  let skipLevel = 0;
  let propsTable = false;
  for (const [i, line] of lines.entries()) {
    const { text } = line;
    const heading = headingOf(line);
    if (heading) {
      const level = heading[1].length;
      if (skipLevel && level > skipLevel) continue;
      const title = heading[2];
      const skip =
        (kind === "component" && title === "Usage") ||
        (!details && EXAMPLE_HEADINGS.has(title));
      skipLevel = skip ? level : 0;
      if (!skip && !(kind === "component" && title === "Props")) push(text);
      continue;
    }
    if (skipLevel) continue;
    if (line.code) {
      push(text);
      continue;
    }
    if (text.startsWith("|")) {
      if (/^\|[\s:|-]+\|$/.test(text)) continue;
      if (/^\|[\s:|-]+\|$/.test(lines[i + 1]?.text ?? "")) {
        propsTable = /^\|\s*Prop\s*\|/.test(text);
        continue;
      }
      const cells = tableCells(text);
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
          sharedProps.set(earlier, [...(sharedProps.get(earlier) ?? []), name]);
          continue;
        }
        printed.set(prop, owner);
        push(prop);
      } else {
        push(`- ${cells.join(" | ")}`);
      }
      continue;
    }
    if (NOT_PROSE.test(text)) continue;
    if (kind === "component" && text.trim()) {
      // The generator repeats a page's intro in its component's section; other names' text is referred back to.
      const earlier = printed.get(text);
      if (earlier && earlier !== owner) {
        const reference = `(as in ${earlier})`;
        if (lastText !== reference) push(reference);
        continue;
      }
      if (text === intro) continue;
      intro ||= text;
      printed.set(text, owner);
    }
    if (text.trim() || (out.length && out[out.length - 1].trim())) push(text);
  }
  for (const [earlier, props] of sharedProps) {
    push(`- ${props.join(", ")}: as in ${earlier}`);
  }
  return out.join("\n").trim();
}

function sectionLines(entry: ApiEntry): Line[] {
  const lines = linesOf(entry.file);
  let end = entry.line + 1;
  for (; end < lines.length; end++) {
    const heading = headingOf(lines[end]);
    if (heading && heading[1].length <= entry.level) break;
  }
  return lines.slice(entry.line, end);
}

/** Reference pages detail every member; among several names, one gets its declaration and member names. */
function declarationOnly(lines: Line[], name: string): Line[] {
  const end = lines.findIndex(
    (line, i) => i > 0 && headingOf(line)?.[1] === "##",
  );
  const declaration = end < 0 ? lines : lines.slice(0, end);
  const members = lines.flatMap((line) => {
    const heading = headingOf(line);
    return heading?.[1] === "###" ? [heading[2]] : [];
  });
  if (!members.length) return declaration;
  const prose = (text: string) => ({ text, code: false });
  return [
    ...declaration,
    prose(""),
    prose(`Members: ${members.join(", ")} (\`appkit docs ${name}\` for each)`),
  ];
}

function firstProseLine(entry: ApiEntry): string {
  for (const line of sectionLines(entry).slice(1)) {
    if (headingOf(line)) return "";
    if (!line.code && line.text.trim() && !NOT_PROSE.test(line.text)) {
      return line.text.trim();
    }
  }
  return "";
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
  const scores = new Map(
    [...index].map(([candidate, entry]) => [
      candidate,
      2 * hits(candidate) +
        (entry.kind === "component" ? hits(firstProseLine(entry)) : 0),
    ]),
  );
  return [...scores.keys()]
    .filter((candidate) => (scores.get(candidate) ?? 0) > 0)
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    .slice(0, 6);
}

/**
 * `appkit docs NAME...`: what each name's docs say and whether any was found, or null for a section query. Names
 * come as separate arguments or as one ("BarChart DataTable"); a section name has spaces too, so a single argument
 * that isn't all names and matches a section is a section query. One that matches neither also lists the sections.
 */
export function lookUp(
  packageRoot: string,
  queries: string[],
  sections: Section[],
): { text: string; found: boolean } | null {
  const names = queries.flatMap((q) => q.split(/[\s,]+/)).filter(Boolean);
  if (!names.length) return null;
  const index = apiIndex(packageRoot);
  const single = queries.length === 1;
  const allNames = names.every((name) => index.has(name));
  if (single && !allNames && findSections(sections, queries[0]).length) {
    return null;
  }

  const details = names.length === 1;
  const printed: Printed = new Map();
  const entries = names.map((name) => {
    const entry = index.get(name);
    if (!entry) {
      const similar = similarNames(index, name);
      return `=== ${name}\nNot documented.${similar.length ? ` Similar: ${similar.join(", ")}` : ""}`;
    }
    const section = sectionLines(entry);
    const lines =
      entry.kind === "reference" && !details
        ? declarationOnly(section, name)
        : section;
    const where = path.relative(packageRoot, entry.file);
    return `=== ${name} (${where})\n${condense(lines, entry.kind, name, details, printed)}`;
  });
  const found = names.some((name) => index.has(name));
  if (single && !found && sections.length) {
    entries.push(
      `No section matches either. Sections: ${sections.map((s) => s.name).join(", ")}`,
    );
  }
  return { text: entries.join("\n\n"), found };
}

function runDocs(queries: string[], options: { full?: boolean }) {
  const packageRoot = findPackageRoot();
  const [query] = queries;

  if (query && isFilePath(query)) {
    readDocFile(packageRoot, query);
    return;
  }

  const content = readLlmsTxt(packageRoot);
  const { header, sections } = parseSections(content);

  const answer = lookUp(packageRoot, queries, sections);
  if (answer) {
    console.log(answer.text);
    if (!answer.found) process.exit(1);
    return;
  }

  if (options.full) {
    console.log(content.replaceAll(` ${COLLAPSED_MARKER}`, ""));
    return;
  }

  const matched = query ? findSections(sections, query) : [];
  if (matched.length) {
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

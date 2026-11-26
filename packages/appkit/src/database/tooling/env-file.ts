import fs from "node:fs";

import {
  refuseSymlink as refuseLink,
  SymlinkRefusedError,
  writeFileAtomic,
} from "./files";

/**
 * An entry's first line: indentation and `export ` (kept on rewrite), the key,
 * the value. dotenv also reads `KEY: value` (a colon, then whitespace); a
 * rewrite writes it back as `KEY=`.
 */
const ENTRY = /^(\s*(?:export\s+)?)([\w.-]+)(?:\s*=\s*|:\s+)(.*)$/;
const QUOTES = new Set(['"', "'", "`"]);
const PLAIN_VALUE = /^[A-Za-z0-9_./:@+-]*$/;

/**
 * A value dotenv reads back unchanged, always on one line: plain; else
 * double-quoted, where dotenv turns `\n` and `\r` back into line breaks; else
 * single-quoted, which dotenv takes literally.
 */
function formatValue(key: string, value: string): string {
  if (PLAIN_VALUE.test(value)) return value;
  if (!/["\\]/.test(value)) {
    return `"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  }
  if (!/['\r\n]/.test(value)) return `'${value}'`;
  throw new Error(
    `Cannot write ${key} to .env: its value mixes quotes, backslashes and line breaks.`,
  );
}

/** Like dotenv, a quote preceded by a backslash does not close the value. */
function closes(text: string, quote: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    if (text[i] === quote && text[i - 1] !== "\\") return true;
  }
  return false;
}

interface Entry {
  /** null for comments, blank lines and lines dotenv does not read as `KEY=`. */
  readonly key: string | null;
  readonly prefix: string;
  readonly lines: readonly string[];
}

/** A quoted value without its closing quote continues on the next lines, as dotenv reads it. */
function entries(lines: readonly string[]): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const match = ENTRY.exec(line);
    if (!match) {
      out.push({ key: null, prefix: "", lines: [line] });
      continue;
    }
    const value = match[3] ?? "";
    const quote = value[0] ?? "";
    let end = i;
    if (QUOTES.has(quote) && !closes(value, quote, 1)) {
      const closing = lines.findIndex(
        (next, j) => j > i && closes(next, quote, 0),
      );
      if (closing !== -1) end = closing;
    }
    out.push({
      key: match[2] ?? null,
      prefix: match[1] ?? "",
      lines: lines.slice(i, end + 1),
    });
    i = end;
  }
  return out;
}

export function refuseSymlink(file: string): void {
  try {
    refuseLink(file);
  } catch (error) {
    if (!(error instanceof SymlinkRefusedError)) throw error;
    throw new Error(
      `Refusing to rewrite ${file}: it is a symbolic link to ${fs.readlinkSync(file)}, and writing through it would change that file. Replace it with a regular file, then rerun.`,
    );
  }
}

/**
 * Replace `KEY=…` entries, append missing keys, and remove the keys whose
 * value is null. Comments, blank lines, other keys, their order, `export `
 * prefixes and CRLF line endings are kept. Written 0600 through a temporary
 * file; a symbolic link is refused.
 */
export function updateEnvFile(
  file: string,
  values: Readonly<Record<string, string | null>>,
): void {
  refuseSymlink(file);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines =
    text.length > 0 ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];

  const written = new Set<string>();
  const out: string[] = [];
  for (const entry of entries(lines)) {
    const { key } = entry;
    if (key === null || !Object.hasOwn(values, key)) {
      out.push(...entry.lines);
      continue;
    }
    const value = values[key];
    // Later duplicates of a managed key are dropped, so the value is unambiguous.
    if (value === null || written.has(key)) continue;
    written.add(key);
    out.push(`${entry.prefix}${key}=${formatValue(key, value ?? "")}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && !written.has(key)) {
      out.push(`${key}=${formatValue(key, value)}`);
    }
  }
  writeFileAtomic(file, `${out.join(eol)}${eol}`, { mode: 0o600 });
}

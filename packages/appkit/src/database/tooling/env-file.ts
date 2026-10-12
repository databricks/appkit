import fs from "node:fs";

/** Captures any indentation and `export ` before the key, so a rewrite keeps them. */
const KEY_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/;
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

/**
 * Replace `KEY=…` lines in place and append missing keys. Comments, blank
 * lines, other keys, their order, `export ` prefixes and CRLF line endings are
 * kept. A missing file starts from `seedFrom` (e.g. .env.example) when that
 * exists. Written 0600.
 */
export function updateEnvFile(
  file: string,
  values: Readonly<Record<string, string>>,
  seedFrom?: string,
): void {
  const source = fs.existsSync(file)
    ? file
    : seedFrom && fs.existsSync(seedFrom)
      ? seedFrom
      : null;
  const text = source ? fs.readFileSync(source, "utf-8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines =
    text.length > 0 ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];

  const written = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const match = KEY_LINE.exec(line);
    const key = match?.[2];
    if (key === undefined || !Object.hasOwn(values, key)) {
      out.push(line);
      continue;
    }
    // Later duplicates of a managed key are dropped, so the value is unambiguous.
    if (written.has(key)) continue;
    written.add(key);
    out.push(`${match?.[1] ?? ""}${key}=${formatValue(key, values[key])}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!written.has(key)) out.push(`${key}=${formatValue(key, value)}`);
  }

  fs.writeFileSync(file, `${out.join(eol)}${eol}`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Renders the conditional blocks of the template's Go `text/template` syntax so
 * the smoke test and template tests can scaffold the way `databricks apps init`
 * does, without the Databricks CLI.
 *
 * Only `{{if}}` / `{{else if}}` / `{{else}}` / `{{end}}` chains whose conditions
 * read the variables in `RENDERED_ROOTS` are evaluated, with Go's trim markers
 * and truthiness. Every other action (`{{.projectName}}`, `{{range}}`, an `if`
 * on `$vars` or `.bundle`) is kept verbatim, while `if` chains nested inside it
 * are still rendered. Conditions may use `not`, `and`, `or` and parentheses.
 */

/** Template variables whose conditions are rendered; others are left as-is. */
export const RENDERED_ROOTS = ["plugins", "appEnv", "skipExamples"] as const;

export interface TemplateVars {
  /** Selected plugins, as `apps init` passes them (`{{if .plugins.analytics}}`). */
  plugins?: Record<string, object>;
  appEnv?: string;
  /** Builder mode: omit the example queries and example test. */
  skipExamples?: boolean;
}

interface Text {
  type: "text";
  value: string;
}

interface Action {
  type: "action";
  raw: string;
  body: string;
  trimLeft: boolean;
  trimRight: boolean;
  /** Set when the action is consumed by rendering, so its trim markers apply. */
  rendered?: boolean;
}

type Token = Text | Action;

interface Branch {
  /** `undefined` for a plain `{{else}}`. */
  condition: string | undefined;
  action: Action;
  children: Node[];
}

interface Block {
  type: "block";
  /** `if` blocks are a chain of branches; other blocks have exactly one. */
  keyword: string;
  branches: Branch[];
  end: Action;
}

type Node = Text | Action | Block;

const ACTION = /{{(-\s)?([\s\S]*?)(\s-)?}}/g;
const BLOCK_KEYWORDS = new Set(["if", "range", "with", "define", "block"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of source.matchAll(ACTION)) {
    if (match.index > last) {
      tokens.push({ type: "text", value: source.slice(last, match.index) });
    }
    tokens.push({
      type: "action",
      raw: match[0],
      body: match[2].trim(),
      trimLeft: match[1] !== undefined,
      trimRight: match[3] !== undefined,
    });
    last = match.index + match[0].length;
  }
  if (last < source.length) {
    tokens.push({ type: "text", value: source.slice(last) });
  }
  return tokens;
}

function keywordOf(body: string): string {
  return body.split(/\s+/, 1)[0];
}

function parse(tokens: Token[]): Node[] {
  let index = 0;

  function parseNodes(): { nodes: Node[]; stop?: Action } {
    const nodes: Node[] = [];
    while (index < tokens.length) {
      const token = tokens[index++];
      if (token.type === "text") {
        nodes.push(token);
        continue;
      }
      const keyword = keywordOf(token.body);
      if (keyword === "end" || keyword === "else") {
        return { nodes, stop: token };
      }
      if (!BLOCK_KEYWORDS.has(keyword)) {
        nodes.push(token);
        continue;
      }
      const branches: Branch[] = [];
      let action = token;
      let condition: string | undefined = token.body.slice(keyword.length);
      for (;;) {
        const { nodes: children, stop } = parseNodes();
        branches.push({ condition, action, children });
        if (!stop) throw new Error(`Unclosed {{${token.body}}}`);
        if (keywordOf(stop.body) === "end") {
          nodes.push({ type: "block", keyword, branches, end: stop });
          break;
        }
        // `{{else}}` or `{{else if cond}}`
        const rest = stop.body.slice("else".length).trim();
        action = stop;
        condition = rest.startsWith("if ") ? rest.slice(3) : undefined;
      }
    }
    return { nodes };
  }

  const { nodes, stop } = parseNodes();
  if (stop) throw new Error(`Unexpected {{${stop.body}}}`);
  return nodes;
}

class Unrendered extends Error {}

/** Splits a pipeline into its terms, keeping parenthesised groups and strings whole. */
function terms(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    let j = i;
    if (char === "(") {
      let depth = 0;
      for (; j < source.length; j++) {
        if (source[j] === "(") depth++;
        if (source[j] === ")" && --depth === 0) break;
      }
      j++;
    } else if (char === '"') {
      j = source.indexOf('"', i + 1) + 1;
      if (j === 0) throw new Unrendered();
    } else {
      while (j < source.length && !/[\s()]/.test(source[j])) j++;
    }
    out.push(source.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Go's `text/template` truthiness. Objects count as true like the non-nil
 * `*pluginVar` pointers `apps init` passes for selected plugins.
 */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function evaluateTerm(term: string, vars: TemplateVars): unknown {
  if (term.startsWith("(") && term.endsWith(")")) {
    return evaluate(term.slice(1, -1), vars);
  }
  if (term.startsWith('"')) return term.slice(1, -1);
  if (!term.startsWith(".")) throw new Unrendered();
  const path = term.slice(1).split(".");
  if (!(RENDERED_ROOTS as readonly string[]).includes(path[0])) {
    throw new Unrendered();
  }
  let value: unknown = vars;
  for (const key of path) {
    value =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

function evaluate(pipeline: string, vars: TemplateVars): unknown {
  const [head, ...args] = terms(pipeline);
  if (head === undefined) throw new Unrendered();
  const values = () => args.map((arg) => evaluateTerm(arg, vars));
  switch (head) {
    case "not":
      if (args.length !== 1) throw new Unrendered();
      return !truthy(evaluateTerm(args[0], vars));
    case "and": {
      let value: unknown = true;
      for (const arg of values()) if (!truthy((value = arg))) return arg;
      return value;
    }
    case "or": {
      let value: unknown = false;
      for (const arg of values()) if (truthy((value = arg))) return arg;
      return value;
    }
    default:
      if (args.length) throw new Unrendered();
      return evaluateTerm(head, vars);
  }
}

/** The branch an `if` chain renders, `null` for none, or `undefined` if it can't be decided. */
function chooseBranch(
  block: Block,
  vars: TemplateVars,
): Branch | null | undefined {
  try {
    // Evaluate every condition so a chain mixing rendered and other variables stays verbatim.
    const results = block.branches.map(
      (branch) =>
        branch.condition === undefined ||
        truthy(evaluate(branch.condition, vars)),
    );
    const index = results.indexOf(true);
    return index === -1 ? null : block.branches[index];
  } catch (error) {
    if (error instanceof Unrendered) return undefined;
    throw error;
  }
}

/** Marks the actions of every renderable `if` chain so their trim markers apply. */
function mark(nodes: Node[], vars: TemplateVars): void {
  for (const node of nodes) {
    if (node.type !== "block") continue;
    if (node.keyword === "if" && chooseBranch(node, vars) !== undefined) {
      for (const branch of node.branches) branch.action.rendered = true;
      node.end.rendered = true;
    }
    for (const branch of node.branches) mark(branch.children, vars);
  }
}

function applyTrims(tokens: Token[]): void {
  tokens.forEach((token, i) => {
    if (token.type !== "action" || !token.rendered) return;
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    if (token.trimLeft && before?.type === "text") {
      before.value = before.value.trimEnd();
    }
    if (token.trimRight && after?.type === "text") {
      after.value = after.value.trimStart();
    }
  });
}

function render(nodes: Node[], vars: TemplateVars): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
    } else if (node.type === "action") {
      out += node.raw;
    } else {
      const chosen =
        node.keyword === "if" ? chooseBranch(node, vars) : undefined;
      if (chosen === undefined) {
        for (const branch of node.branches) {
          out += branch.action.raw + render(branch.children, vars);
        }
        out += node.end.raw;
      } else if (chosen) {
        out += render(chosen.children, vars);
      }
    }
  }
  return out;
}

/**
 * Renders the `if` chains of a template file that read `RENDERED_ROOTS`.
 * Like `apps init`, callers should skip a file whose result is only whitespace.
 */
export function renderTemplateConditionals(
  source: string,
  vars: TemplateVars,
): string {
  const tokens = tokenize(source);
  const nodes = parse(tokens);
  mark(nodes, vars);
  applyTrims(tokens);
  return render(nodes, vars);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Renders template files in place with the default `apps init` variables, e.g.
  // so the raw template's own tests can run. Files that render empty are removed.
  const files = process.argv.slice(2);
  if (!files.length) {
    throw new Error("Usage: tsx tools/template-render.ts <file>...");
  }
  for (const file of files) {
    const rendered = renderTemplateConditionals(readFileSync(file, "utf-8"), {
      plugins: {},
    });
    if (rendered.trim()) writeFileSync(file, rendered);
    else rmSync(file);
  }
}

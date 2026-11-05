/**
 * Streamed TSX drafts (SPIKE, KIT-40): the latest renderable version of
 * `.staging/<name>.tsx` is served as `pages/<name>.tsx` and hot-swapped in place.
 */

type Frame =
  | { k: "brace" | "paren" | "bracket" | "tpl" | "tplExpr" | "jsxExpr" }
  | { k: "tag" | "el"; name: string };

const CLOSER: Record<string, string> = {
  brace: "}",
  tplExpr: "}",
  jsxExpr: "}",
  paren: ")",
  bracket: "]",
  tpl: "`",
};

/** A `<` after one of these (or at the start) opens JSX rather than comparing. */
const JSX_AFTER = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "?",
  "[",
  "{",
  "!",
  "&",
  "|",
  ">",
  ";",
  "}",
]);
const JSX_AFTER_WORD = /(?:^|[^\w$])(?:return|yield|default|case)$/;

/**
 * Closes the brackets, template literals and JSX still open at the end of `src`;
 * null when it ends inside a string or comment, or has a stray closer.
 *
 * @internal
 */
export function closeOpen(src: string): string | null {
  const stack: Frame[] = [];
  const top = () => stack[stack.length - 1];
  // Last non-space character (or keyword) seen in code, to tell JSX from `<`.
  let prev = "";
  let i = 0;
  const n = src.length;

  const skipString = (q: string) => {
    for (i++; i < n; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === q) return true;
      else if (src[i] === "\n") return false;
    }
    return false;
  };
  const readName = () => {
    const m = /^[\w$.:-]*/.exec(src.slice(i));
    i += m?.[0].length ?? 0;
    return m?.[0] ?? "";
  };

  while (i < n) {
    const c = src[i];
    const f = top();
    const mode = f?.k ?? "brace";

    if (mode === "tpl") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        prev = "`";
        i++;
      } else if (c === "$" && src[i + 1] === "{") {
        stack.push({ k: "tplExpr" });
        prev = "{";
        i += 2;
      } else i++;
      continue;
    }

    if (mode === "tag") {
      if (c === '"' || c === "'") {
        if (!skipString(c)) return null;
        i++;
      } else if (c === "{") {
        stack.push({ k: "jsxExpr" });
        prev = "{";
        i++;
      } else if (c === "/" && src[i + 1] === ">") {
        stack.pop();
        prev = ">";
        i += 2;
      } else if (c === ">") {
        const tag = stack.pop() as { name: string };
        stack.push({ k: "el", name: tag.name });
        i++;
      } else i++;
      continue;
    }

    if (mode === "el") {
      if (c === "{") {
        stack.push({ k: "jsxExpr" });
        prev = "{";
        i++;
      } else if (c === "<" && src[i + 1] === "/") {
        const end = src.indexOf(">", i);
        if (end === -1) return null;
        stack.pop();
        prev = ">";
        i = end + 1;
      } else if (c === "<") {
        i++;
        stack.push({ k: "tag", name: readName() });
      } else i++;
      continue;
    }

    // Code (top level, brackets, ${...} and JSX {...}).
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!skipString(c)) return null;
      prev = c;
      i++;
      continue;
    }
    if (c === "`") {
      stack.push({ k: "tpl" });
      i++;
      continue;
    }
    if (c === "/" && JSX_AFTER.has(prev) && prev !== ">" && prev !== "}") {
      // A regex literal.
      for (i++; i < n && src[i] !== "/"; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") return null;
      }
      i++;
      prev = "/";
      continue;
    }
    if (
      c === "<" &&
      /[A-Za-z>]/.test(src[i + 1] ?? "") &&
      (JSX_AFTER.has(prev) ||
        JSX_AFTER_WORD.test(src.slice(Math.max(0, i - 12), i).trimEnd()))
    ) {
      // `<T extends X>(` / `<T,>(` is a generic arrow's type parameters, not a tag.
      if (/^<[\w$]+\s*(?:\bextends\b|,)/.test(src.slice(i, i + 80))) {
        let depth = 0;
        for (; i < n; i++) {
          if (src[i] === "<") depth++;
          else if (src[i] === ">" && src[i - 1] !== "=" && --depth === 0) break;
        }
        if (i >= n) return null;
        i++;
        prev = ">";
        continue;
      }
      i++;
      stack.push({ k: "tag", name: readName() });
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      stack.push({ k: c === "{" ? "brace" : c === "(" ? "paren" : "bracket" });
      prev = c;
      i++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      const want =
        c === "}"
          ? ["brace", "tplExpr", "jsxExpr"]
          : c === ")"
            ? ["paren"]
            : ["bracket"];
      if (!f || !want.includes(f.k)) return null;
      stack.pop();
      prev = c;
      i++;
      continue;
    }
    if (/[\w$]/.test(c)) {
      const m = /^[\w$]+/.exec(src.slice(i)) as RegExpExecArray;
      prev = m[0];
      i += m[0].length;
      continue;
    }
    prev = c;
    i++;
  }

  let out = src;
  for (let j = stack.length - 1; j >= 0; j--) {
    const fr = stack[j];
    if (fr.k === "tag") out += " />";
    else if (fr.k === "el") out += `</${(fr as { name: string }).name}>`;
    else out += CLOSER[fr.k];
  }
  return out;
}

/** Strips a leading markdown fence (and a closing one), as writers sometimes add. */
function stripFence(src: string): string {
  return src.replace(/^\s*```[\w-]*\n/, "").replace(/\n```\s*$/, "\n");
}

const DECLARED =
  /(?:function|class|const|let|var)\s+([A-Z][\w$]*)|import\s+([A-Z][\w$]*)|import\s*\{([^}]*)\}|import\s+\*\s+as\s+([A-Z][\w$]*)/g;

/** The skeleton shape a stubbed component gets, from its name. */
export function placeholderKind(
  name: string,
): "chart" | "table" | "card" | "generic" {
  if (/Chart|Graph|Trend|Spark|Plot|Heatmap/.test(name)) return "chart";
  if (/Table|List|Grid|Rows|Log|Board|Feed|Queue/.test(name)) return "table";
  if (/Card|Kpi|KPI|Stat|Tile|Metric|Summary|Panel/.test(name)) return "card";
  return "generic";
}

/** Undeclared JSX components (helpers not written yet), stubbed with DraftPlaceholder. */
function stubComponents(code: string): string {
  const declared = new Set<string>();
  for (const m of code.matchAll(DECLARED)) {
    for (const name of [m[1], m[2], m[4]]) if (name) declared.add(name);
    for (const spec of m[3]?.split(",") ?? []) {
      const local = spec
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.replace(/^type\s+/, "");
      if (local) declared.add(local);
    }
  }
  const missing = new Set<string>();
  for (const m of code.matchAll(
    /(?<![\w$])<([A-Z][\w$]*)(?!\s*(?:extends\b|,))/g,
  )) {
    if (!declared.has(m[1])) missing.add(m[1]);
  }
  if (missing.size === 0) return code;
  const stubs = [...missing].map(
    (name) =>
      `function ${name}() { return <__DraftPlaceholder kind="${placeholderKind(name)}" />; }`,
  );
  return `import { DraftPlaceholder as __DraftPlaceholder } from "@databricks/appkit-ui/react/beta";\n${code}\n${stubs.join("\n")}\n`;
}

/** Checks that a candidate parses; the dev server's own TSX transform. */
type IsValid = (code: string) => Promise<boolean>;

/** How many line cuts to try, newest first, before keeping the previous version. */
const MAX_CUTS = 60;

/**
 * The longest renderable line-boundary cut of a streamed page, open constructs
 * closed and undeclared components stubbed; null until one works.
 *
 * @internal
 */
export async function renderablePartial(
  source: string,
  isValid: IsValid,
  {
    page = true,
    complete = false,
    boundary = false,
  }: {
    page?: boolean;
    complete?: boolean;
    /** Only cuts with nothing open (complete top-level declarations). */
    boundary?: boolean;
  } = {},
): Promise<string | null> {
  const src = stripFence(source);
  if (complete && (await isValid(src))) return src;
  const lines = src.split("\n");
  // The last line is unfinished unless the source ends with a newline.
  let end = lines.length - 1;
  for (let tries = 0; end > 0 && tries < MAX_CUTS; end--, tries++) {
    const cut = lines.slice(0, end).join("\n");
    if (page && !/export\s+default\b/.test(cut)) return null;
    const closed = closeOpen(cut);
    if (closed === null || (boundary && closed !== cut)) continue;
    const code = page ? stubComponents(closed) : closed;
    if (await isValid(code)) return code;
  }
  return null;
}

/** Value names a page imports from `../<mock>` (type-only imports excluded). */
export function mockImports(page: string, mock = "mock"): string[] {
  const names: string[] = [];
  for (const m of page.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/([\w-]+?)(?:\.ts)?["']/g,
  )) {
    if (m[2] !== mock) continue;
    for (const spec of m[1].split(",")) {
      const s = spec.trim();
      if (!s || s.startsWith("type ")) continue;
      names.push(s.split(/\s+as\s+/)[0]);
    }
  }
  return names;
}

/** Stands in for mock values not written yet: never throws, renders as nothing. */
const DRAFT_VALUE = `const __draftValue: any = (() => {
  const target: any = function () {};
  const value: any = new Proxy(target, {
    get: (_t, key) =>
      key === Symbol.toPrimitive
        ? (hint: string) => (hint === "number" ? 0 : "")
        : key === Symbol.iterator
          ? function* () {}
          : key === "then"
            ? undefined
            : value,
    apply: () => value,
    construct: () => value,
  });
  return value;
})();`;

/**
 * The partial mock plus a placeholder for each value a page imports from it that
 * isn't defined yet (a missing named export would be a SyntaxError).
 *
 * @internal
 */
export function stubMock(mock: string, imported: Iterable<string>): string {
  const exported = new Set(
    [
      ...mock
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
        .matchAll(/export\s+(?:const|let|var|function|class|enum)\s+([\w$]+)/g),
    ].map((m) => m[1]),
  );
  const stubs = [...new Set(imported)].filter((name) => !exported.has(name));
  return stubs.length === 0
    ? mock
    : `${mock}\n${DRAFT_VALUE}\n${stubs.map((name) => `export const ${name}: any = __draftValue;`).join("\n")}\n`;
}

/**
 * Browser entry of `/design/__stream/<name>`: renders each published version
 * through DesignPage, and reports frames as `appkit:stream-frame` (same origin).
 *
 * @internal
 */
export function streamHostModule(name: string): string {
  return `
import { Component, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DesignPage } from "@databricks/appkit-ui/react/beta";
import.meta.glob("/src/index.css", { eager: true });

const NAME = ${JSON.stringify(name)};
const rootEl = document.getElementById("root");
const report = (msg) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "appkit:stream-frame", name: NAME, t: performance.timeOrigin + performance.now(), ...msg }, location.origin);
  }
};

let host = null;
class Host extends Component {
  // reset retries after an error; generation remounts the page.
  state = { reset: 0, generation: 0 };
  failed = false;
  componentDidMount() {
    host = this;
  }
  onError = (error) => {
    this.failed = true;
    report({ kind: "kept", error: String(error?.message ?? error) });
  };
  retry() {
    if (!this.failed) return;
    this.failed = false;
    this.setState((s) => ({ reset: s.reset + 1 }));
  }
  remount() {
    this.failed = false;
    this.setState((s) => ({ reset: s.reset + 1, generation: s.generation + 1 }));
  }
  render() {
    return createElement(
      DesignPage,
      { onError: this.onError, resetKey: this.state.reset, errorFallback: () => null },
      createElement(this.props.page, { key: this.state.generation }),
    );
  }
}

// A visible update (a DOM change), reported once per painted frame.
let pending = false;
new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() =>
    setTimeout(() => {
      pending = false;
      if (host?.failed) return;
      report({
        kind: "frame",
        chars: rootEl.innerText.trim().length,
        height: rootEl.scrollHeight,
        empty: rootEl.childElementCount === 0,
        overlay: !!document.querySelector("vite-error-overlay"),
      });
    }, 0),
  );
}).observe(rootEl, { subtree: true, childList: true, characterData: true, attributes: true });

// Removes Vite's error overlay: a version that doesn't build stays unpublished.
new MutationObserver(() => document.querySelector("vite-error-overlay")?.remove()).observe(document.body, { childList: true });

// The finished file mounts afresh, so kept chart state can't carry over.
let final = false;
let remountTimer;
const remount = (ms) => {
  clearTimeout(remountTimer);
  remountTimer = setTimeout(() => {
    final = false;
    host?.remount();
    report({ kind: "final" });
  }, ms);
};
import.meta.hot?.on("vite:afterUpdate", () => {
  report({ kind: "update" });
  if (final) remount(100);
  // Fast Refresh applies the update a moment later; then retry.
  setTimeout(() => host?.retry(), 50);
});

let mounted = false;
async function mount() {
  if (mounted) return;
  try {
    const mod = await import(/* @vite-ignore */ "/src/design/pages/" + NAME + ".tsx?t=" + Date.now());
    if (mounted) return;
    mounted = true;
    createRoot(rootEl).render(createElement(Host, { page: mod.default }));
  } catch {}
}
import.meta.hot?.on("appkit:stream", (data) => {
  if (data?.name !== NAME) return;
  report({ kind: "stream", ...data });
  if (data.done) {
    final = true;
    remount(1000);
  }
  mount();
});
mount();
report({ kind: "host-ready" });
`;
}

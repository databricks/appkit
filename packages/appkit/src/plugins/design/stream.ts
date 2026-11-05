/**
 * Streamed TSX drafts: makes the growing source of a design page renderable
 * at every step, so a page can be shown while a writer is still producing it.
 *
 * SPIKE (KIT-40). A builder appends a draft's source to
 * `src/design/.staging/<name>.tsx` as it streams. The dev server holds the
 * latest renderable version of it under the page's real module id
 * (`src/design/pages/<name>.tsx`) and pushes it to the browser as a hot
 * update, so React Fast Refresh swaps it in place (state and chart instances
 * survive). Once the builder writes the finished file there, the same module
 * id loads it from disk.
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
 * Appends whatever closes the constructs still open at the end of `src`
 * (brackets, template literals, JSX tags and expression containers). Returns
 * null when `src` ends inside a string or comment, or has a stray closer: such
 * a cut can't be closed, a shorter one has to be tried.
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

/**
 * Components used as JSX tags but not declared or imported yet (helpers a
 * writer defines below the page), stubbed to render nothing so the page
 * renders before they arrive.
 */
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
  for (const m of code.matchAll(/(?<![\w$])<([A-Z][\w$]*)/g)) {
    if (!declared.has(m[1])) missing.add(m[1]);
  }
  return missing.size === 0
    ? code
    : `${code}\n${[...missing].map((name) => `function ${name}() { return null; }`).join("\n")}\n`;
}

/** Checks that a candidate parses; the dev server's own TSX transform. */
type IsValid = (code: string) => Promise<boolean>;

/** How many line cuts to try, newest first, before keeping the previous version. */
const MAX_CUTS = 60;

/**
 * The longest renderable version of a streamed page (or module): the source
 * cut at a line boundary (an unfinished last line dropped, then earlier cuts
 * until one closes and parses), its open constructs closed, and undeclared
 * JSX components stubbed. A page must have its default export. Null when no
 * cut works yet.
 *
 * @internal
 */
export async function renderablePartial(
  source: string,
  isValid: IsValid,
  {
    page = true,
    complete = false,
  }: { page?: boolean; complete?: boolean } = {},
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
    if (closed === null) continue;
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

/**
 * The partial mock module plus an empty-array stub for every value a
 * streamed page imports that the mock hasn't defined yet, so the page module
 * links (a missing named export is a SyntaxError) and renders what it can.
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
    : `${mock}\n${stubs.map((name) => `export const ${name}: any = [];`).join("\n")}\n`;
}

/**
 * Browser entry of `/design/__stream/<name>`: renders the streamed page
 * `src/design/pages/<name>.tsx` as the dev server publishes versions of it
 * (each one a hot update, applied by Fast Refresh). A version that throws
 * while rendering is never shown: its error boundary renders a copy of the
 * last good frame in the same commit, and the next version retries. Vite's
 * error overlay is removed. Frames are reported to an embedding page as
 * `appkit:stream-frame` messages (same origin), for measuring.
 *
 * @internal
 */
export function streamHostModule(name: string): string {
  return `
import { Component, createElement } from "react";
import { createRoot } from "react-dom/client";
import.meta.glob("/src/index.css", { eager: true });

const NAME = ${JSON.stringify(name)};
const rootEl = document.getElementById("root");
const report = (msg) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "appkit:stream-frame", name: NAME, t: performance.timeOrigin + performance.now(), ...msg }, location.origin);
  }
};

// The last good frame: a copy of the page's DOM, canvases (charts) as pixels.
let snapshot = null;
function takeSnapshot() {
  const nodes = [...rootEl.childNodes].map((n) => n.cloneNode(true));
  const pixels = [...rootEl.querySelectorAll("canvas")].map((c) => {
    const copy = document.createElement("canvas");
    copy.width = c.width;
    copy.height = c.height;
    copy.style.cssText = c.style.cssText;
    copy.getContext("2d")?.drawImage(c, 0, 0);
    return copy;
  });
  snapshot = { nodes, pixels };
}
function restoreSnapshot(holder) {
  if (!holder || !snapshot) return;
  holder.replaceChildren(...snapshot.nodes.map((n) => n.cloneNode(true)));
  holder.querySelectorAll("canvas").forEach((c, i) => {
    const px = snapshot.pixels[i];
    if (!px) return;
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.drawImage(px, 0, 0);
  });
}

let boundary = null;
class Keep extends Component {
  state = { error: null, generation: 0 };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidMount() {
    boundary = this;
  }
  componentDidCatch(error) {
    report({ kind: "kept", error: String(error?.message ?? error) });
  }
  render() {
    if (this.state.error) {
      return createElement("div", { style: { display: "contents" }, ref: restoreSnapshot });
    }
    return createElement(this.props.page, { key: this.state.generation });
  }
}

// A visible update: the page's DOM changed (charts draw on canvases, so
// their animation isn't one). Reported once per painted frame, with a copy
// kept as the last good frame.
let pending = false;
new MutationObserver(() => {
  if (pending || boundary?.state.error) return;
  pending = true;
  requestAnimationFrame(() =>
    setTimeout(() => {
      pending = false;
      if (boundary?.state.error) return;
      takeSnapshot();
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

// The finished file is mounted afresh, so it renders exactly as the compiled
// page: kept chart instances merge new options into old ones (a series an
// earlier version had can stay drawn). Its hot update lands a moment after
// the stream's end is announced.
let final = false;
let remountTimer;
const remount = (ms) => {
  clearTimeout(remountTimer);
  remountTimer = setTimeout(() => {
    final = false;
    boundary?.setState((s) => ({ error: null, generation: s.generation + 1 }));
    report({ kind: "final" });
  }, ms);
};
import.meta.hot?.on("vite:afterUpdate", () => {
  report({ kind: "update" });
  if (final) remount(100);
  // Fast Refresh applies the update a moment later; then a boundary showing
  // the last good frame retries with the new version.
  setTimeout(() => boundary?.state.error && boundary.setState({ error: null }), 50);
});

let mounted = false;
async function mount() {
  if (mounted) return;
  try {
    const mod = await import(/* @vite-ignore */ "/src/design/pages/" + NAME + ".tsx?t=" + Date.now());
    if (mounted) return;
    mounted = true;
    createRoot(rootEl).render(createElement(Keep, { page: mod.default }));
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

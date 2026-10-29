import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";

/** `/design/drafts/<name>` → `drafts/<name>.html` (relative to the app). */
export const DRAFT_ROUTE = /^\/design\/drafts\/([A-Za-z0-9_-]+)\/?$/;
const DRAFT_FILE = /^([A-Za-z0-9_-]+)\.html$/;

/** A draft as listed in `/design/__status`. */
interface DraftInfo {
  name: string;
  path: string;
}

/** Every `drafts/*.html`, by name. @internal */
export function listDrafts(projectRoot: string): DraftInfo[] {
  const dir = path.join(projectRoot, "drafts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => DRAFT_FILE.exec(f)?.[1])
    .filter((n): n is string => !!n)
    .sort()
    .map((name) => ({ name, path: `/design/drafts/${name}` }));
}

/** The draft file for a name, or null when there is none. @internal */
export function draftFile(projectRoot: string, name: string): string | null {
  const file = path.join(projectRoot, "drafts", `${name}.html`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Validates a `data-appkit` block and maps it to the appkit-ui component to
 * render. Throws an Error whose message is shown in the draft and sent back to
 * the agent.
 *
 * Runs in the browser too: the hydrator embeds it via `toString()`, so it must
 * stay self-contained (no imports, no outer references).
 *
 * @internal
 */
export function normalizeBlock(
  kind: string,
  props: unknown,
): { component: string; props: Record<string, unknown> } {
  const CHARTS = [
    "BarChart",
    "LineChart",
    "AreaChart",
    "PieChart",
    "DonutChart",
  ];
  const ALLOWED = [...CHARTS, "DataTable", "KpiCard"];
  if (!ALLOWED.includes(kind)) {
    throw new Error(
      `Unknown data-appkit component "${kind}". Allowed: ${ALLOWED.join(", ")}.`,
    );
  }
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new Error(`${kind}: the block must be a JSON object of props.`);
  }
  const p = props as Record<string, unknown>;

  if (CHARTS.includes(kind)) {
    // Native chart props: rows in `data`, optional xKey / yKey.
    if (Array.isArray(p.data)) {
      if (p.data.some((row) => !row || typeof row !== "object")) {
        throw new Error(`${kind}: "data" must be an array of row objects.`);
      }
      return { component: kind, props: p };
    }
    // Compact form: { x: [...labels], series: [{ name, data: [...] }] }.
    const { x, series, ...rest } = p;
    if (!Array.isArray(x)) {
      throw new Error(
        `${kind}: needs "data" (rows) or "x" (labels) with "series".`,
      );
    }
    if (!Array.isArray(series) || series.length === 0) {
      throw new Error(`${kind}: "series" must be a non-empty array.`);
    }
    const names: string[] = [];
    for (const [i, s] of series.entries()) {
      const item = s as { name?: unknown; data?: unknown };
      if (!item || typeof item.name !== "string" || !Array.isArray(item.data)) {
        throw new Error(
          `${kind}: series[${i}] needs a "name" and a "data" array.`,
        );
      }
      if (item.data.length !== x.length) {
        throw new Error(
          `${kind}: series "${item.name}" has ${item.data.length} values for ${x.length} x labels.`,
        );
      }
      names.push(item.name);
    }
    const data = x.map((label, i) => {
      const row: Record<string, unknown> = { x: label };
      for (const s of series as { name: string; data: unknown[] }[]) {
        row[s.name] = s.data[i];
      }
      return row;
    });
    return {
      component: kind,
      props: {
        ...rest,
        data,
        xKey: "x",
        yKey: names.length === 1 ? names[0] : names,
      },
    };
  }

  if (kind === "DataTable") {
    const { columns, rows } = p;
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new Error(`DataTable: "columns" must be a non-empty array.`);
    }
    const cols = columns.map((c, i) => {
      if (typeof c === "string") return { key: c, label: c };
      const col = c as { key?: unknown; label?: unknown };
      if (col && typeof col.key === "string") {
        return {
          key: col.key,
          label: typeof col.label === "string" ? col.label : col.key,
        };
      }
      throw new Error(
        `DataTable: columns[${i}] must be a string or { key, label }.`,
      );
    });
    if (!Array.isArray(rows)) {
      throw new Error(`DataTable: "rows" must be an array.`);
    }
    const normalized = rows.map((r, i) => {
      if (Array.isArray(r)) {
        return Object.fromEntries(cols.map((c, j) => [c.key, r[j]]));
      }
      if (r && typeof r === "object") return r as Record<string, unknown>;
      throw new Error(`DataTable: rows[${i}] must be an object or an array.`);
    });
    return {
      component: kind,
      props: { ...p, columns: cols, rows: normalized },
    };
  }

  // KpiCard
  if (typeof p.label !== "string") {
    throw new Error(`KpiCard: "label" must be a string.`);
  }
  if (typeof p.value !== "string" && typeof p.value !== "number") {
    throw new Error(`KpiCard: "value" must be a string or a number.`);
  }
  return { component: kind, props: p };
}

/** Tag injected into every served draft; `async` so it runs while streaming. */
export const hydratorTag = (src: string) =>
  `<script type="module" async src="${src}"></script>`;

/**
 * Puts the hydrator tag at the start of a draft without pushing the doctype
 * down (content before it would switch the page to quirks mode).
 *
 * @internal
 */
export function injectHydrator(html: string, tag: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (!doctype) return tag + html;
  const end = doctype[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}

/**
 * How long a draft must stay unchanged before its response is ended without
 * `</html>`; long enough for an agent pausing mid-write.
 */
const STABLE_MS = 8000;
/** Give up waiting for an empty draft file after this long. */
const FIRST_BYTES_MS = 30000;

/**
 * Streams a draft to the browser while it's still being written: sends what
 * exists, then appends whatever is added, and ends once the file ends with
 * `</html>` or hasn't changed for STABLE_MS. The browser parses it
 * progressively, so the hydrator renders blocks as they complete.
 *
 * @internal
 */
export function streamDraft(
  file: string,
  tag: string,
  res: ServerResponse,
  /** Called with the file's mtime once everything up to it has been sent. */
  onDone?: (mtimeMs: number) => void,
): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const decoder = new TextDecoder();
  const started = Date.now();
  let sent = 0;
  let injected = false;
  let lastChange = Date.now();
  let text = "";

  const timer = setInterval(pump, 100);
  res.on("close", () => clearInterval(timer));
  pump();

  function finish() {
    clearInterval(timer);
    if (!injected) res.write(tag);
    res.end(decoder.decode());
    try {
      onDone?.(fs.statSync(file).mtimeMs);
    } catch {}
  }

  function pump() {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return finish();
    }
    // Rewritten from the start (not appended): end this response; the
    // hydrator reloads the page on the change notification.
    if (bytes.length < sent) return finish();
    if (bytes.length > sent) {
      let chunk = decoder.decode(bytes.subarray(sent), { stream: true });
      sent = bytes.length;
      lastChange = Date.now();
      text += chunk;
      if (!injected) {
        chunk = injectHydrator(chunk, tag);
        injected = true;
      }
      res.write(chunk);
    }
    const now = Date.now();
    if (sent === 0) {
      if (now - started > FIRST_BYTES_MS) finish();
      return;
    }
    if (/<\/html>\s*$/i.test(text) || now - lastChange > STABLE_MS) finish();
  }
}

/**
 * Browser module injected into every served draft. It renders each
 * `<script type="application/json" data-appkit="<Component>">` block with the
 * real appkit-ui component as soon as its JSON is complete (the draft may
 * still be streaming in), inside a shadow root styled with the app's CSS so
 * the draft's own styles are untouched. A block that can't render shows a
 * small placeholder and is reported to `/design/__status` and, as
 * `appkit:draft-error` v1, to the builder origins.
 *
 * @internal
 */
export function hydratorModule(
  draft: string,
  builderOrigins: string[],
  statusPath: string,
): string {
  return `
// Drafts are plain HTML, so nothing installed @vitejs/plugin-react's Fast
// Refresh preamble (an app's index.html gets it from transformIndexHtml, as a
// deferred script that would only run after a streaming draft finished).
// Install it first, then load React and the components.
import { injectIntoGlobalHook } from "/@react-refresh";
import fallbackCss from "@databricks/appkit-ui/styles.css?inline";
injectIntoGlobalHook(window);
window.$RefreshReg$ ??= () => {};
window.$RefreshSig$ ??= () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const [{ createElement: h }, { createRoot }, UI] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import("@databricks/appkit-ui/react"),
]);

const DRAFT = ${JSON.stringify(draft)};
const ORIGINS = ${JSON.stringify(builderOrigins)};
const normalizeBlock = ${normalizeBlock.toString()};

// The app's compiled styles (theme tokens + the Tailwind utilities appkit-ui
// uses), scoped to each block's shadow root. Tailwind's @property rules are
// ignored inside shadow roots, so they go to the document instead.
const appCss = Object.values(
  import.meta.glob("/src/index.css", { query: "?inline", import: "default", eager: true }),
)[0];
const css = String(appCss ?? fallbackCss);
const properties = css.match(/@property[^{]+\\{[^}]*\\}/g) ?? [];
if (properties.length) {
  const style = document.createElement("style");
  style.textContent = properties.join("\\n");
  document.head.append(style);
}
const shadowCss = css.replaceAll(":root", ":host");

const text = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const RENDER = {
  DataTable: ({ columns, rows }) =>
    h(UI.Table, null,
      h(UI.TableHeader, null, h(UI.TableRow, null, columns.map((c) => h(UI.TableHead, { key: c.key }, c.label)))),
      h(UI.TableBody, null, rows.map((r, i) =>
        h(UI.TableRow, { key: i }, columns.map((c) => h(UI.TableCell, { key: c.key }, text(r[c.key])))),
      )),
    ),
  KpiCard: ({ label, value, delta, hint }) =>
    h(UI.Card, null,
      h(UI.CardHeader, null, h(UI.CardDescription, null, label), h(UI.CardTitle, { className: "text-2xl" }, text(value))),
      delta != null || hint != null
        ? h(UI.CardContent, { className: "text-sm text-muted-foreground" }, [delta, hint].filter((v) => v != null).map(text).join(" · "))
        : null,
    ),
};

function mount(script) {
  const host = document.createElement("div");
  host.setAttribute("data-appkit-block", script.dataset.appkit);
  host.style.display = "block";
  script.after(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = shadowCss;
  const root = document.createElement("div");
  shadow.append(style, root);
  return root;
}

const blocks = () => [...document.querySelectorAll('script[type="application/json"][data-appkit]')];
const handled = new WeakSet();

function fail(script, error) {
  handled.add(script);
  const component = script.dataset.appkit;
  const message = error instanceof Error ? error.message : String(error);
  const box = mount(script);
  createRoot(box).render(
    h("div", {
      style: { padding: "12px", border: "1px dashed var(--border)", borderRadius: "8px", color: "var(--muted-foreground)", font: "13px system-ui, sans-serif" },
    }, "Couldn't render " + component + ": " + message),
  );
  const report = { draft: DRAFT, block: blocks().indexOf(script), component, error: message };
  fetch(${JSON.stringify(statusPath)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  }).catch(() => {});
  const target = window.parent !== window ? window.parent : window.opener;
  if (target) {
    for (const origin of ORIGINS) {
      target.postMessage({ type: "appkit:draft-error", version: 1, ...report }, origin);
    }
  }
}

// final: the document is complete, so JSON that still doesn't parse never will.
function scan(final) {
  for (const script of blocks()) {
    if (handled.has(script)) continue;
    let props;
    try {
      props = JSON.parse(script.textContent);
    } catch (error) {
      if (final) fail(script, new Error("invalid JSON: " + (error?.message ?? error)));
      continue; // still streaming in
    }
    try {
      const spec = normalizeBlock(script.dataset.appkit, props);
      handled.add(script);
      const render = RENDER[spec.component];
      createRoot(mount(script)).render(render ? render(spec.props) : h(UI[spec.component], spec.props));
    } catch (error) {
      fail(script, error);
    }
  }
}

// A new load of this draft: earlier errors are replaced by this one's.
fetch(${JSON.stringify(statusPath)}, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ draft: DRAFT, reset: true }),
}).catch(() => {});

if (document.readyState === "loading") {
  const observer = new MutationObserver(() => scan(false));
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  document.addEventListener("DOMContentLoaded", () => {
    observer.disconnect();
    scan(true);
  });
  scan(false);
} else {
  scan(true);
}

// The draft file changed after it finished loading: show the new version.
import.meta.hot?.on("appkit:draft-changed", (data) => {
  if (data?.draft === DRAFT && document.readyState !== "loading") location.reload();
});
`;
}

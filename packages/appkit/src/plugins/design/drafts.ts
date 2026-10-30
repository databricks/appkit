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

/**
 * JSON Schema (2020-12) of each component allowed in a `data-appkit` block,
 * with an example. Served at `/design/__data-appkit.schema.json` so an agent
 * (or its skill) can write valid blocks; `normalizeBlock` enforces the same
 * rules at render time.
 */
export function dataAppkitSchema() {
  const chartBase = {
    title: {
      type: "string",
      description:
        "Heading shown above the chart. Leave it out when the block's container already has its own heading.",
    },
    height: {
      type: "number",
      description:
        "Height in pixels. By default the chart fills its container's height (at least 160px).",
    },
    showLegend: { type: "boolean", description: "Show the legend." },
    colors: {
      type: "array",
      items: { type: "string" },
      description: "Series colors (CSS colors); defaults to the theme palette.",
    },
    ariaLabel: { type: "string" },
  };
  const orientation = {
    enum: ["vertical", "horizontal"],
    description: "Default vertical.",
  };
  const compact = {
    type: "object",
    required: ["x", "series"],
    properties: {
      x: {
        type: "array",
        minItems: 1,
        items: { type: ["string", "number"] },
        description: "Category or x-axis labels.",
      },
      series: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "data"],
          properties: {
            name: { type: "string" },
            data: {
              type: "array",
              items: { type: ["number", "null"] },
              description: "One value per x label (same length as x).",
            },
          },
        },
      },
    },
  };
  const rows = {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "array",
        items: { type: "object" },
        description: 'Rows, e.g. [{"day":"Mon","trips":12}].',
      },
      xKey: {
        type: "string",
        description: "Row field for x / categories. Auto-detected.",
      },
      yKey: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "Row field(s) for values. Auto-detected.",
      },
    },
  };
  const chart = (
    description: string,
    extra: Record<string, unknown>,
    example: unknown,
  ) => ({
    description,
    schema: {
      type: "object",
      oneOf: [compact, rows],
      properties: { ...chartBase, ...extra },
    },
    example,
  });
  const pie = {
    innerRadius: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Inner radius in %.",
    },
    showLabels: {
      type: "boolean",
      description: "Labels on slices. Default true.",
    },
    labelPosition: { enum: ["outside", "inside", "center"] },
  };
  const singleSeries = {
    x: ["Madrid", "Rome", "Paris"],
    series: [{ name: "Trips", data: [320, 280, 150] }],
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "data-appkit blocks",
    description:
      'Props for <script type="application/json" data-appkit="<Component>">…</script> blocks in drafts. Each block is one JSON object matching its component\'s schema.',
    components: {
      BarChart: chart(
        "Bar chart (appkit-ui BarChart).",
        { orientation, stacked: { type: "boolean" } },
        {
          title: "Trips per day",
          x: ["Mon", "Tue", "Wed"],
          series: [{ name: "Trips", data: [12, 19, 7] }],
        },
      ),
      LineChart: chart(
        "Line chart (appkit-ui LineChart).",
        {
          orientation,
          smooth: { type: "boolean" },
          showSymbol: { type: "boolean" },
        },
        {
          title: "Revenue",
          x: ["Jan", "Feb", "Mar"],
          series: [
            { name: "2025", data: [10, 14, 13] },
            { name: "2026", data: [12, 18, 21] },
          ],
        },
      ),
      AreaChart: chart(
        "Area chart (appkit-ui AreaChart).",
        {
          orientation,
          smooth: { type: "boolean" },
          showSymbol: { type: "boolean" },
          stacked: { type: "boolean" },
        },
        {
          title: "Signups",
          data: [
            { week: "W1", signups: 40 },
            { week: "W2", signups: 55 },
          ],
          xKey: "week",
          yKey: "signups",
        },
      ),
      PieChart: chart(
        "Pie chart (appkit-ui PieChart). One series; x are the slice names.",
        pie,
        { title: "Trips by city", ...singleSeries },
      ),
      DonutChart: chart(
        "Donut chart (appkit-ui DonutChart). One series; x are the slice names.",
        pie,
        { title: "Trips by city", ...singleSeries },
      ),
      DataTable: {
        description: "Static table (appkit-ui Table).",
        schema: {
          type: "object",
          required: ["columns", "rows"],
          properties: {
            columns: {
              type: "array",
              minItems: 1,
              items: {
                oneOf: [
                  {
                    type: "string",
                    description: "Field name, also used as the header.",
                  },
                  {
                    type: "object",
                    required: ["key"],
                    properties: {
                      key: { type: "string", description: "Row field." },
                      label: {
                        type: "string",
                        description: "Header; defaults to key.",
                      },
                    },
                  },
                ],
              },
            },
            rows: {
              type: "array",
              items: {
                oneOf: [
                  { type: "object", description: "Keyed by column key." },
                  { type: "array", description: "Values in column order." },
                ],
              },
            },
          },
        },
        example: {
          columns: [
            { key: "city", label: "City" },
            { key: "trips", label: "Trips" },
          ],
          rows: [{ city: "Madrid", trips: 320 }, ["Rome", 280]],
        },
      },
      KpiCard: {
        description: "KPI card (appkit-ui Card).",
        schema: {
          type: "object",
          required: ["label", "value"],
          properties: {
            label: { type: "string" },
            value: { type: ["string", "number"] },
            delta: {
              type: ["string", "number"],
              description: 'E.g. "+4% vs last week".',
            },
            hint: { type: "string" },
          },
        },
        example: {
          label: "Total trips",
          value: "1,204",
          delta: "+4% vs last week",
        },
      },
    },
  };
}

/**
 * The app template's theme tokens as a standalone stylesheet for drafts
 * (`/design/drafts/theme.css`): appkit-ui's CSS variables for light, for dark
 * via `prefers-color-scheme` (unless `.light`), and for an explicit `.dark`,
 * plus a zero-specificity page background and text color. Drafts link it
 * instead of inlining a theme block.
 *
 * @internal
 */
export function themeCss(appkitUiCss: string): string {
  const tokens = (body = "") =>
    body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((d) => d.trim())
      .filter((d) => /^(--[\w-]+|color-scheme)\s*:/.test(d))
      .map((d) => `  ${d.replace(/\s+/g, " ")};`)
      .join("\n");
  const light = /(?:^|\n)\s*:root\s*\{([^}]*)\}/.exec(appkitUiCss)?.[1];
  const dark =
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\.light\)\s*\{([^}]*)\}/.exec(
      appkitUiCss,
    )?.[1];
  const darkClass = /(?:^|\n)\s*\.dark\s*\{([^}]*)\}/.exec(appkitUiCss)?.[1];
  return `/* AppKit theme tokens for drafts: light, and dark when the system prefers it. */
:root {
${tokens(light)}
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
${tokens(dark).replace(/^/gm, "  ")}
  }
}
.dark {
${tokens(darkClass)}
}
:where(body) {
  background: var(--background);
  color: var(--foreground);
}
`;
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

/** What {@link runHydrator} needs; injected so it can run under test. */
interface HydratorDeps {
  draft: string;
  origins: string[];
  statusPath: string;
  /** App CSS (or appkit-ui's) to scope into each block's shadow root. */
  css: string;
  h: (...args: any[]) => unknown;
  createRoot: (el: unknown) => { render(node: unknown): void };
  UI: Record<string, unknown>;
  normalizeBlock: typeof normalizeBlock;
  fetch: (url: string, init: RequestInit) => Promise<unknown>;
}

/**
 * Renders a draft's `data-appkit` blocks and reports the ones that can't
 * render. Runs in the browser: the hydrator embeds it via `toString()`, so it
 * must stay self-contained (everything comes in through `deps`).
 *
 * @internal
 */
export function runHydrator(deps: HydratorDeps): {
  scan(final: boolean): void;
} {
  const { draft, origins, statusPath, css, h, createRoot, UI } = deps;
  // Browser globals; reached through globalThis because this package compiles
  // without the DOM typings.
  const win = globalThis as any;
  const document = win.document;

  // Tailwind's @property rules are ignored inside shadow roots: hoist them.
  const properties = css.match(/@property[^{]+\{[^}]*\}/g) ?? [];
  if (properties.length) {
    const style = document.createElement("style");
    style.textContent = properties.join("\n");
    document.head?.append(style);
  }
  // :root becomes :host; a compound like :root:not(.light) (the dark-mode
  // tokens) must become :host(:not(.light)), since :host:not(...) never
  // matches inside a shadow root.
  const shadowCss = css
    .replace(/:root((?::not\([^)]*\))+)/g, ":host($1)")
    .replaceAll(":root", ":host");

  // Charts read their theme tokens from the document root, where a draft
  // defines none: copy the resolved tokens there, at the lowest priority
  // (:where), so a draft's own variables still win. Re-synced when the
  // system color scheme changes.
  const tokenNames = [
    ...new Set(css.match(/--(?!tw-)[a-zA-Z][\w-]*(?=\s*:)/g) ?? []),
  ];
  const tokens = document.createElement("style");
  tokens.setAttribute("data-appkit-tokens", "");
  (document.head ?? document.documentElement).prepend(tokens);
  const probe = document.createElement("div");
  probe.hidden = true;
  probe.attachShadow({ mode: "open" }).innerHTML =
    "<style>" + shadowCss + "</style>";
  document.documentElement.append(probe);
  const syncTokens = () => {
    const resolved = win.getComputedStyle(probe);
    tokens.textContent =
      ":where(:root){" +
      tokenNames
        .map((n) => {
          const v = resolved.getPropertyValue(n).trim();
          return v ? n + ":" + v + ";" : "";
        })
        .join("") +
      "}";
  };
  syncTokens();
  win
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", syncTokens);

  const text = (v: unknown) =>
    v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const RENDER: Record<string, (p: any) => unknown> = {
    DataTable: ({
      columns,
      rows,
    }: {
      columns: { key: string; label: string }[];
      rows: Record<string, unknown>[];
    }) =>
      h(
        UI.Table,
        null,
        h(
          UI.TableHeader,
          null,
          h(
            UI.TableRow,
            null,
            columns.map((c) => h(UI.TableHead, { key: c.key }, c.label)),
          ),
        ),
        h(
          UI.TableBody,
          null,
          rows.map((r, i) =>
            h(
              UI.TableRow,
              { key: i },
              columns.map((c) =>
                h(UI.TableCell, { key: c.key }, text(r[c.key])),
              ),
            ),
          ),
        ),
      ),
    KpiCard: ({
      label,
      value,
      delta,
      hint,
    }: {
      label: string;
      value: unknown;
      delta?: unknown;
      hint?: unknown;
    }) =>
      h(
        UI.Card,
        null,
        h(
          UI.CardHeader,
          null,
          h(UI.CardDescription, null, label),
          h(UI.CardTitle, { className: "text-2xl" }, text(value)),
        ),
        delta != null || hint != null
          ? h(
              UI.CardContent,
              { className: "text-sm text-muted-foreground" },
              [delta, hint]
                .filter((v) => v != null)
                .map(text)
                .join(" · "),
            )
          : null,
      ),
  };

  // Skeleton while a block's JSON is still streaming in, then a short fade-in
  // when it renders; both off with prefers-reduced-motion.
  const blockCss = `
.appkit-skeleton { min-height: 160px; border-radius: 8px; background: var(--muted, #f4f4f5); animation: appkit-pulse 1.4s ease-in-out infinite; }
.appkit-skeleton[data-kind="KpiCard"] { min-height: 96px; }
.appkit-root { height: 100%; display: flex; flex-direction: column; }
.appkit-title { margin: 0 0 8px; font: 600 14px/1.4 system-ui, sans-serif; color: var(--card-foreground, inherit); }
.appkit-chart { flex: 1 1 auto; min-height: 0; }
.appkit-fade { opacity: 0; transition: opacity 200ms ease-out; }
.appkit-fade.appkit-in { opacity: 1; }
@keyframes appkit-pulse { 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) {
  .appkit-skeleton { animation: none; }
  .appkit-fade { transition: none; }
}`;

  // One host per block, right after its script in the block's own container:
  // the skeleton and later the rendered component live in its shadow root.
  // A host already there (the hydrator ran twice) is reused, never doubled.
  const hostOf = (script: any) => {
    const next = script.nextElementSibling;
    if (next?.hasAttribute?.("data-appkit-block") && next.shadowRoot) {
      return next;
    }
    const host = document.createElement("div");
    host.setAttribute("data-appkit-block", script.dataset.appkit ?? "");
    host.style.display = "block";
    // The block fills its container when it's all the container holds (an
    // agent's sized box); next to a heading or text it keeps its own height,
    // so it can't push out of the container.
    const alone = [...(script.parentElement?.children ?? [])].every(
      (el: any) =>
        el === script ||
        el.hasAttribute("data-appkit-block") ||
        (el.tagName === "SCRIPT" && el.hasAttribute("data-appkit")),
    );
    if (alone) host.style.height = "100%";
    script.after(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = shadowCss + blockCss;
    shadow.append(style);
    return host;
  };
  const shadowOf = (script: any) => hostOf(script).shadowRoot;
  // Blocks already shown in this page, by content: one the browser re-parses
  // (same JSON) renders again without fading in again.
  const shown: Set<string> = (win.__appkitShownBlocks ??= new Set());
  const skeleton = (script: any) => {
    const shadow = shadowOf(script);
    if (shadow.querySelector(".appkit-skeleton")) return;
    const bone = document.createElement("div");
    bone.className = "appkit-skeleton";
    bone.setAttribute("data-kind", script.dataset.appkit ?? "");
    shadow.append(bone);
  };
  const mount = (script: any) => {
    const host = hostOf(script);
    host.setAttribute("data-appkit-state", "rendered");
    const shadow = host.shadowRoot;
    shadow.querySelector(".appkit-skeleton")?.remove();
    const root = document.createElement("div");
    root.className = "appkit-root";
    shadow.append(root);
    const key = (script.dataset.appkit ?? "") + "\0" + script.textContent;
    if (!shown.has(key)) {
      shown.add(key);
      root.classList.add("appkit-fade");
      // Two frames so the initial opacity is painted before the transition.
      win.requestAnimationFrame?.(() =>
        win.requestAnimationFrame?.(() => root.classList.add("appkit-in")),
      );
    }
    return root;
  };

  const blocks = () => [
    ...document.querySelectorAll(
      'script[type="application/json"][data-appkit]',
    ),
  ];
  const handled = new WeakSet<any>();

  const post = (body: unknown) =>
    deps
      .fetch(statusPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      .catch(() => {});

  const fail = (script: any, error: unknown) => {
    handled.add(script);
    const component = script.dataset.appkit ?? "";
    const message = error instanceof Error ? error.message : String(error);
    createRoot(mount(script)).render(
      h(
        "div",
        {
          "data-appkit-error": "",
          style: {
            padding: "12px",
            border: "1px dashed var(--border)",
            borderRadius: "8px",
            color: "var(--muted-foreground)",
            font: "13px system-ui, sans-serif",
          },
        },
        "Couldn't render " + component + ": " + message,
      ),
    );
    const report = {
      draft,
      block: blocks().indexOf(script),
      component,
      error: message,
    };
    post(report);
    const target = win.parent !== win ? win.parent : win.opener;
    if (target) {
      for (const origin of origins) {
        target.postMessage(
          { type: "appkit:draft-error", version: 1, ...report },
          origin,
        );
      }
    }
  };

  // final: the document is complete, so JSON that still doesn't parse never will.
  const scan = (final: boolean) => {
    for (const script of blocks()) {
      if (handled.has(script)) continue;
      // Rendered by an earlier run of the hydrator in this page.
      const next = script.nextElementSibling;
      if (
        next?.hasAttribute?.("data-appkit-block") &&
        next.getAttribute("data-appkit-state") === "rendered"
      ) {
        handled.add(script);
        continue;
      }
      let props: unknown;
      try {
        props = JSON.parse(script.textContent ?? "");
      } catch (error) {
        if (final) {
          fail(
            script,
            new Error("invalid JSON: " + ((error as Error)?.message ?? error)),
          );
        } else {
          skeleton(script); // still streaming in
        }
        continue;
      }
      try {
        const spec = deps.normalizeBlock(script.dataset.appkit ?? "", props);
        handled.add(script);
        const render = RENDER[spec.component];
        if (render) {
          createRoot(mount(script)).render(render(spec.props));
        } else {
          // A chart: its title is a heading above it, not drawn inside the
          // chart where ECharts would put it over the axes and legend.
          const { title, ...props } = spec.props as Record<string, unknown>;
          createRoot(mount(script)).render([
            title != null
              ? h("div", { key: "t", className: "appkit-title" }, text(title))
              : null,
            h(
              "div",
              { key: "c", className: "appkit-chart" },
              h(UI[spec.component], props),
            ),
          ]);
        }
      } catch (error) {
        fail(script, error);
      }
    }
  };

  // A new load of this draft: earlier errors are replaced by this one's.
  post({ draft, reset: true });

  if (document.readyState === "loading") {
    const observer = new win.MutationObserver(() => scan(false));
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener("DOMContentLoaded", () => {
      observer.disconnect();
      scan(true);
    });
    scan(false);
  } else {
    scan(true);
  }
  return { scan };
}

/**
 * Browser module injected into every served draft: loads React and
 * appkit-ui, then runs {@link runHydrator}, which renders each
 * `<script type="application/json" data-appkit="<Component>">` block with the
 * real appkit-ui component as soon as its JSON is complete (the draft may
 * still be streaming in) and reports blocks that can't render to
 * `/design/__status` and, as `appkit:draft-error` v1, to the builder origins.
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
const [{ createElement }, { createRoot }, UI] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import("@databricks/appkit-ui/react"),
]);

// The app's compiled styles: theme tokens plus the Tailwind utilities
// appkit-ui uses.
const appCss = Object.values(
  import.meta.glob("/src/index.css", { query: "?inline", import: "default", eager: true }),
)[0];

const DRAFT = ${JSON.stringify(draft)};
// Some TypeScript loaders (tsx, esbuild keepNames) wrap named functions in a
// __name() helper; toString() below copies those calls but not the helper.
const __name = (target) => target;
const normalizeBlock = ${normalizeBlock.toString()};
const runHydrator = ${runHydrator.toString()};
runHydrator({
  draft: DRAFT,
  origins: ${JSON.stringify(builderOrigins)},
  // Absolute, from this module's origin: the draft may be served from another
  // origin (e.g. the App Builder runtime streaming it). Deliberately not the
  // two-argument URL constructor with the module URL as base: Vite rewrites
  // that pattern as an asset URL (to /@fs/...).
  statusPath: new URL(import.meta.url).origin + ${JSON.stringify(statusPath)},
  css: String(appCss ?? fallbackCss),
  h: createElement,
  createRoot,
  UI,
  normalizeBlock,
  fetch: (url, init) => fetch(url, init),
});

// The draft file changed after it finished loading: show the new version.
// (Only for drafts this dev server serves, not ones streamed from elsewhere.)
import.meta.hot?.on("appkit:draft-changed", (data) => {
  if (
    data?.draft === DRAFT &&
    location.pathname.replace(/[/]$/, "") === "/design/drafts/" + DRAFT &&
    document.readyState !== "loading"
  ) {
    location.reload();
  }
});
`;
}

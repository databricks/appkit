import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { Plugin, ViteDevServer } from "vite";

import {
  mockImports,
  renderablePartial,
  streamHostModule,
  stubMock,
} from "./stream";

/**
 * One virtual entry per page: `virtual:appkit-design-page:<file>.mjs`. The
 * `.mjs` keeps @vitejs/plugin-react from treating the entry as a `.tsx`
 * component module and injecting Fast Refresh code that imports it by id.
 */
const ENTRY_PREFIX = "virtual:appkit-design-page:";
const ENTRY_SUFFIX = ".mjs";
/** Script added to the app's own pages (not /design) to post appkit:app-ready. */
const APP_READY_ID = "virtual:appkit-app-ready.mjs";
/** Host page of a streamed TSX draft: `virtual:appkit-design-stream:<name>.mjs`. */
const STREAM_HOST_PREFIX = "virtual:appkit-design-stream:";

/**
 * Marks the app template's default home page. While an element carrying it
 * is on screen the app isn't reported ready, so a builder never reveals the
 * placeholder home page. Remove it with the page when the app gets real
 * content.
 */
const TEMPLATE_HOME_ATTR = "data-appkit-template-home";
const PAGE_FILE = /^(index|pages\/[A-Za-z0-9_-]+)\.(tsx|jsx)$/;
const DESIGN_ROUTE = /^\/design(?:\/([A-Za-z0-9_-]+))?\/?$/;
const STATUS_PATH = "/design/__status";
/** `/design/__stream/<name>`: a TSX draft rendered while it's being written. */
const STREAM_ROUTE = /^\/design\/__stream\/([A-Za-z0-9_-]+)\/?$/;
/**
 * SPIKE: `APPKIT_DESIGN_STREAM_MODE=boundary` publishes a streamed page only
 * at component boundaries (complete top-level declarations) instead of at
 * any line, for comparing the two.
 */
const STREAM_MODE = process.env.APPKIT_DESIGN_STREAM_MODE;
/** At most one published version per stream in this long. */
const STREAM_INTERVAL_MS = 150;
const EXTENSIONS = [".tsx", ".jsx"];

/**
 * `pages/index.tsx` would collide with the root page, and `__*` with the
 * plugin's own endpoints (`/design/__status`, `/design/__stream/<name>`), so
 * those names aren't pages.
 */
const isReservedName = (name: string) =>
  name === "index" || name.startsWith("__");

/** Page files the browser entry may route to (reserved names excluded). */
const PAGE_GLOBS = [
  "/src/design/index.{tsx,jsx}",
  "/src/design/pages/*.{tsx,jsx}",
  "!/src/design/pages/index.{tsx,jsx}",
  "!/src/design/pages/__*",
];

/**
 * Marks the template's starter page. A page exporting it is never reported
 * as ready, so a builder doesn't reveal the starter while the real design is
 * still being written. Delete the export when replacing the page.
 */
const PLACEHOLDER_EXPORT = /export\s+const\s+designPlaceholder\s*=\s*true/;

/** A design page as listed in the status and ready payloads. */
interface DesignPageInfo {
  /** `index`, or the `<name>` of `pages/<name>.tsx`. */
  name: string;
  /** URL of the page: `/design` or `/design/<name>`. */
  path: string;
}

/**
 * Maps a request path to its design page file under `<clientRoot>/src/design`:
 * `/design` → `index.tsx`, `/design/<name>` → `pages/<name>.tsx`.
 * Returns `undefined` for paths outside `/design`, and `null` for anything
 * under `/design` that isn't an existing page (served as 404).
 *
 * @internal
 */
export function resolveDesignPage(
  clientRoot: string,
  pathname: string,
): string | null | undefined {
  if (pathname !== "/design" && !pathname.startsWith("/design/")) {
    return undefined;
  }
  const match = DESIGN_ROUTE.exec(pathname);
  if (!match || (match[1] && isReservedName(match[1]))) return null;
  const base = match[1]
    ? path.join(clientRoot, "src/design/pages", match[1])
    : path.join(clientRoot, "src/design/index");
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return null;
}

/** Every existing design page, index first. @internal */
export function listDesignPages(clientRoot: string): DesignPageInfo[] {
  const pages: DesignPageInfo[] = [];
  if (resolveDesignPage(clientRoot, "/design")) {
    pages.push({ name: "index", path: "/design" });
  }
  const dir = path.join(clientRoot, "src/design/pages");
  const names = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .map((f) => /^([A-Za-z0-9_-]+)\.(tsx|jsx)$/.exec(f)?.[1])
        .filter((n): n is string => !!n && !isReservedName(n))
    : [];
  for (const name of [...new Set(names)].sort()) {
    pages.push({ name, path: `/design/${name}` });
  }
  return pages;
}

/** Modification time of a design page's file, or undefined when there is none. */
function pageVersion(clientRoot: string, name: string): number | undefined {
  const file = resolveDesignPage(
    clientRoot,
    name === "index" ? "/design" : `/design/${name}`,
  );
  return file ? fs.statSync(file).mtimeMs : undefined;
}

/** The app's entry module, from the `<script type="module" src>` of index.html. */
function appEntry(clientRoot: string): string | undefined {
  let html: string;
  try {
    html = fs.readFileSync(path.join(clientRoot, "index.html"), "utf-8");
  } catch {
    return undefined;
  }
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    const src = /\bsrc=["']([^"']+)["']/.exec(tag)?.[1];
    if (/type=["']module["']/.test(tag) && src && !src.startsWith("/@")) {
      return src;
    }
  }
  return undefined;
}

type ReportedError = { error: string };

/**
 * `/design/__status`: ready once `index.tsx` exists, isn't the template
 * placeholder, and has rendered in a browser (visible or not) since it last
 * changed (`paintedVersion` is the file's mtime when that was reported).
 *
 * @internal
 */
export function designStatus(
  clientRoot: string,
  paintedVersion: number | undefined,
): { ready: boolean; placeholder: boolean; pages: DesignPageInfo[] } {
  const index = resolveDesignPage(clientRoot, "/design");
  const placeholder =
    !!index && PLACEHOLDER_EXPORT.test(fs.readFileSync(index, "utf-8"));
  const real = !!index && !placeholder;
  const painted =
    paintedVersion !== undefined &&
    paintedVersion === pageVersion(clientRoot, "index");
  return {
    ready: real && painted,
    placeholder,
    pages: listDesignPages(clientRoot),
  };
}

/**
 * A design page's state in `/design/__status`, from what the plugin knows:
 * `compile-error` (its module graph doesn't build), `rendering` (builds, no
 * browser has rendered this version yet), `ready` (rendered, no errors) or
 * `failed` (a browser reported errors).
 *
 * @internal
 */
export function pageState(page: {
  compiled: boolean;
  rendered: boolean;
  errors: ReportedError[] | null;
}): "compile-error" | "rendering" | "ready" | "failed" {
  if (!page.compiled) return "compile-error";
  if (page.errors?.length) return "failed";
  return page.rendered ? "ready" : "rendering";
}

/**
 * Whether the page entry can use react-router 7+ (the template ships it):
 * Node's resolution from the design page, i.e. the app's own copy. Not from
 * this plugin's folder (pnpm may hoist an older react-router there), and not
 * through Vite, which returns its pre-bundled copy in node_modules/.vite/deps,
 * whose package.json has no name or version.
 */
function hasReactRouter(clientRoot: string): boolean {
  let entry: string;
  try {
    entry = createRequire(
      path.join(clientRoot, "src/design/index.tsx"),
    ).resolve("react-router");
  } catch {
    return false;
  }
  for (
    let dir = path.dirname(entry);
    dir !== path.dirname(dir);
    dir = path.dirname(dir)
  ) {
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) continue;
    const { name, version } = JSON.parse(fs.readFileSync(pkg, "utf-8"));
    if (name !== "react-router") continue;
    return Number.parseInt(String(version), 10) >= 7;
  }
  return false;
}

/**
 * Browser code shared by the design-page entry and the app-ready script:
 * `settled(isCurrent)` resolves once the page shows its real content (web
 * fonts loaded, no `useDesignReady(false)` holder, no page fetch in flight,
 * no DOM change for 300 ms, then two frames). Expects the including module to
 * define `schedule()`, which it calls when a fetch completes.
 */
const SETTLE_SNIPPET = `
// Shared with appkit-ui's useDesignReady(): components holding readiness back
// bump \`blockers\` and call \`changed()\` when they let go.
// CONTRACT: keep the key and shape in sync with appkit-ui's use-design-ready.ts.
const host = (window.__appkitDesign ??= { blockers: 0 });

// In-flight fetches started by the page (chart data and the like). Our own
// status POSTs are not counted.
let pendingFetches = 0;
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.includes("${STATUS_PATH}")) return realFetch(input, init);
  pendingFetches++;
  return realFetch(input, init).finally(() => {
    pendingFetches--;
    // The response still has to be read and rendered: count its arrival as
    // activity so the quiet window starts after it, not before.
    lastMutation = performance.now();
    schedule();
  });
};

const QUIET_MS = 300;
// Automatic waits (fetches, DOM changes) give up after this, so a stream that
// never ends can't hold the page back forever. useDesignReady(false) has no cap.
const SETTLE_CAP_MS = 10000;
const frame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastMutation = performance.now();
new MutationObserver(() => (lastMutation = performance.now())).observe(document.getElementById("root"), {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
});

// Two frames (painted), or 100 ms without them: a builder may keep the page
// hidden (a preview it reveals when ready), and hidden frames get none.
const painted = () => Promise.race([frame().then(frame), sleep(100)]);

// Resolves once the page shows its real content: fonts loaded, no fetch in
// flight, no DOM change for QUIET_MS, then painted (or hidden). Nothing here
// looks at pixels: it's the same for any page.
async function settled(isCurrent) {
  await document.fonts?.ready;
  const start = performance.now();
  while (isCurrent()) {
    const capped = performance.now() - start > SETTLE_CAP_MS;
    const quiet = performance.now() - lastMutation >= QUIET_MS;
    if (host.blockers === 0 && (capped || (pendingFetches === 0 && quiet))) break;
    await sleep(50);
  }
  await painted();
}

// Reports to ${STATUS_PATH}, one at a time and in order (a late report must
// not overtake a newer one).
let statusQueue = Promise.resolve();
function sendStatus(body) {
  statusQueue = statusQueue.then(() =>
    realFetch("${STATUS_PATH}", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {}),
  );
}

// Errors outside React's render (or without an error boundary): uncaught
// errors, unhandled promise rejections, and Vite's compile errors.
function watchErrors(report) {
  addEventListener("error", (e) => report(e.error?.message ?? e.message ?? "Script error"));
  addEventListener("unhandledrejection", (e) =>
    report("Unhandled rejection: " + (e.reason?.message ?? String(e.reason))),
  );
  import.meta.hot?.on("vite:error", (payload) => report(payload?.err?.message ?? "Vite error"));
}
`;

/**
 * Entry for one page. The requested page is imported directly; the other
 * pages only load when navigated to, so an unfinished draft can't break this
 * one. With react-router, pages share a router whose basename is `/design`,
 * so `<Link to="/orders">` stays at `/design/orders`.
 *
 * After first paint it reports the page (unless it's the placeholder) to the
 * dev server and posts `appkit:design-ready` to the embedding builder, only
 * to the configured origins.
 *
 * @internal
 */
export function entryModule(
  file: string,
  builderOrigins: string[],
  router: boolean,
): string {
  const shared = `
import { Component, createElement, Suspense, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { DesignPage } from "@databricks/appkit-ui/react/beta";
import * as initial from "/src/design/${file}";
import.meta.glob("/src/index.css", { eager: true });

const ORIGINS = ${JSON.stringify(builderOrigins)};
const pageName = (file) =>
  file.startsWith("/src/design/pages/") ? file.slice(18).replace(/\\.[jt]sx$/, "") : "index";
const pages = Object.keys(import.meta.glob(${JSON.stringify(PAGE_GLOBS)}))
  .map((file) => ({ name: pageName(file), path: pageName(file) === "index" ? "/design" : "/design/" + pageName(file) }))
  .sort((a, b) => (a.name === "index" ? -1 : b.name === "index" ? 1 : a.name.localeCompare(b.name)));

${SETTLE_SNIPPET}
function postStatus(name, ok, error) {
  sendStatus(error ? { page: name, ok, error } : { page: name, ok });
}

function reportReady(name) {
  postStatus(name, true);
  const target = window.parent !== window ? window.parent : window.opener;
  if (!target) return;
  for (const origin of ORIGINS) {
    target.postMessage({ type: "appkit:design-ready", version: 1, page: name, pages }, origin);
  }
}

// The page on screen and whether it rendered (not the placeholder, no error).
let current;
let run = 0;
// A new load of this page: earlier reports are replaced by this one's.
const initialPage = pageName("/src/design/${file}");
sendStatus({ page: initialPage, reset: true });
watchErrors((error) => sendStatus({ page: current?.name ?? initialPage, error }));

// (Re)starts the wait for the current page; a newer render or update cancels
// an older wait, so only the latest state can be reported.
function schedule() {
  if (!current?.ok) return;
  const mine = ++run;
  const { name } = current;
  const isCurrent = () => mine === run && current?.ok && current.name === name;
  settled(isCurrent).then(() => {
    if (isCurrent() && host.blockers === 0) reportReady(name);
  });
}
host.changed = () => {
  if (host.blockers === 0) schedule();
};

// A Suspense fallback on screen means the page isn't showing yet.
function Pending() {
  useLayoutEffect(() => {
    host.blockers++;
    return () => {
      host.blockers--;
      // What it revealed may still draw (charts in effects): wait a quiet window.
      lastMutation = performance.now();
      host.changed();
    };
  }, []);
  return null;
}

// Reports readiness only from a successful render. Every page renders
// through appkit-ui's DesignPage: the app's theme from the first paint, and a
// boundary that keeps the last good frame on screen when a render throws. The
// error is reported here, so a failure in any component the page uses
// un-readies it.
// Mounted pages, so a hot update can retry the ones that hit an error.
const boundaries = new Set();
function withReady(mod, name) {
  const placeholder = mod.designPlaceholder === true;
  return class DesignReady extends Component {
    state = { reset: 0 };
    // Set by DesignPage (it commits before this component's own lifecycle).
    failed = false;
    onError = (error) => {
      this.failed = true;
      current = { name, ok: false };
      postStatus(name, false, error?.message ?? String(error));
    };
    componentDidMount() {
      boundaries.add(this);
      this.settle();
    }
    componentWillUnmount() {
      boundaries.delete(this);
    }
    componentDidUpdate() {
      this.settle();
    }
    retry() {
      this.failed = false;
      this.setState(({ reset }) => ({ reset: reset + 1 }));
    }
    settle() {
      if (this.failed) return;
      current = { name, ok: !placeholder };
      schedule();
    }
    render() {
      return createElement(
        DesignPage,
        { onError: this.onError, resetKey: this.state.reset },
        createElement(Suspense, { fallback: createElement(Pending) }, createElement(mod.default)),
      );
    }
  };
}

// Hot edits re-render in place without remounting; once React has applied
// the edit, wait for the page to settle again before reporting it.
// (Adding or removing the placeholder export reloads the page instead.)
// Errors from before the edit are dropped: what's still wrong reports again
// (a render error as React re-renders, a compile error from Vite).
import.meta.hot?.on("vite:afterUpdate", () => {
  sendStatus({ page: current?.name ?? initialPage, reset: true });
  // Fast Refresh re-renders only the edited modules, and applies them a
  // moment after this event: then a boundary holding an earlier error renders
  // the page again (and catches it again if the edit didn't fix it).
  setTimeout(() => {
    for (const boundary of boundaries) {
      if (boundary.failed) boundary.retry();
    }
    schedule();
  }, 50);
});
`;

  if (!router) {
    return `${shared}
createRoot(document.getElementById("root")).render(
  createElement(withReady(initial, pageName("/src/design/${file}"))),
);
`;
  }

  return `${shared}
import { createBrowserRouter, RouterProvider } from "react-router";

const lazyPages = import.meta.glob(${JSON.stringify(PAGE_GLOBS)});
const routes = Object.keys(lazyPages).map((file) => {
  const name = pageName(file);
  const path = name === "index" ? "/" : "/" + name;
  return file === "/src/design/${file}"
    ? { path, Component: withReady(initial, name) }
    : { path, lazy: async () => ({ Component: withReady(await lazyPages[file](), name) }) };
});
const router = createBrowserRouter(routes, { basename: "/design" });
createRoot(document.getElementById("root")).render(createElement(RouterProvider, { router }));
`;
}

/**
 * Added to the app's own pages in development when a builder origin is set.
 * Once the page has settled (see SETTLE_SNIPPET), and again after client-side
 * navigation or a hot update, it posts `appkit:app-ready` v1 to the embedding
 * builder, unless the template's default home page is on screen.
 *
 * @internal
 */
export function appReadyModule(builderOrigins: string[]): string {
  return `
const ORIGINS = ${JSON.stringify(builderOrigins)};
${SETTLE_SNIPPET}

// A new load of the app: earlier reports are replaced by this one's.
sendStatus({ app: location.pathname, reset: true });
watchErrors((error) => sendStatus({ app: location.pathname, error }));

let run = 0;
function schedule() {
  const mine = ++run;
  settled(() => mine === run).then(() => {
    if (mine !== run || host.blockers > 0) return;
    // Rendered: something is mounted (a crash without an error boundary
    // leaves the root empty, and its error is reported above).
    const ok = (document.getElementById("root")?.childElementCount ?? 0) > 0;
    const template = !!document.querySelector("[${TEMPLATE_HOME_ATTR}]");
    sendStatus({ app: location.pathname, ok, template });
    if (!ok || template) return;
    const target = window.parent !== window ? window.parent : window.opener;
    if (!target) return;
    for (const origin of ORIGINS) {
      target.postMessage({ type: "appkit:app-ready", version: 1, path: location.pathname }, origin);
    }
  });
}
host.changed = () => {
  if (host.blockers === 0) schedule();
};

// Client-side navigation (react-router etc.) changes the page without a load.
for (const method of ["pushState", "replaceState"]) {
  const original = history[method];
  history[method] = function (...args) {
    const result = original.apply(this, args);
    schedule();
    return result;
  };
}
addEventListener("popstate", schedule);
// E.g. the default home page being replaced by the real one. Errors from
// before the edit are dropped: what's still wrong reports again.
import.meta.hot?.on("vite:afterUpdate", () => {
  sendStatus({ app: location.pathname, reset: true });
  setTimeout(schedule, 50);
});
schedule();
`;
}

/** Cap on modules compiled per status check, so a huge graph can't stall it. */
const COMPILE_GRAPH_LIMIT = 500;

/**
 * Compiles `url` and every module of the app it imports, transitively
 * (dependencies in node_modules and virtual modules are skipped), the way a
 * browser loading the page would. Returns the first error, or undefined when
 * the whole graph builds.
 *
 * `transformRequest` alone only compiles the one module; its imports are only
 * resolved, so a syntax error in an imported component would go unnoticed.
 *
 * @internal
 */
export async function compileGraph(
  server: Pick<ViteDevServer, "transformRequest" | "moduleGraph">,
  url: string,
): Promise<string | undefined> {
  const seen = new Set<string>();
  const queue = [url];
  while (queue.length > 0 && seen.size < COMPILE_GRAPH_LIMIT) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      await server.transformRequest(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Name the failing module (Vite's location when it has one), since the
      // error can come from deep in the graph and may not say where.
      const loc = (error as { loc?: { file?: string; line?: number } }).loc;
      const where = loc?.file
        ? `${loc.file}${loc.line ? `:${loc.line}` : ""}`
        : next;
      return message.includes(path.basename(where.split(":")[0]))
        ? message
        : `${where}: ${message}`;
    }
    const mod = await server.moduleGraph.getModuleByUrl(next);
    for (const dep of mod?.importedModules ?? []) {
      const file = dep.file ?? "";
      if (
        !file ||
        file.includes("/node_modules/") ||
        dep.url.startsWith("/@id/")
      ) {
        continue;
      }
      // CSS and assets are imported too; only script modules can fail to build.
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      queue.push(dep.url);
    }
  }
  return undefined;
}

const pageHtml = (title: string, entryUrl: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entryUrl}"></script>
  </body>
</html>
`;

/**
 * Serves `/design` (the default export of `client/src/design/index.tsx`),
 * `/design/<name>` (`client/src/design/pages/<name>.tsx`) and the
 * `/design/__status` readiness endpoint.
 *
 * @internal
 */
export function designVitePlugin({
  builderOrigins = [],
}: { builderOrigins?: string[] } = {}): Plugin {
  let root = process.cwd();
  // The app folder (the dev server's working directory).
  const projectRoot = process.cwd();
  // What a browser reported for each design page, for one version of its file:
  // rendered (mounted, settled; visible or not) and the errors it hit.
  const pageReports = new Map<
    string,
    { version: number | undefined; rendered: boolean; errors: ReportedError[] }
  >();
  // The same for the app's own pages, per path (since its last load or hot
  // update), and the path reported last.
  const appReports = new Map<
    string,
    { rendered: boolean; template: boolean; errors: ReportedError[] }
  >();
  let appPath: string | undefined;

  // Streamed TSX drafts. A builder appends each draft's source as it
  // arrives to src/design/.staging/<name>.tsx (the shared mock's to
  // .staging/mock.ts), and writes the finished file to pages/<name>.tsx
  // (mock.ts) once it type-checks. Until then the page's module is the
  // latest renderable version of its staging file. By name ("mock" for the
  // mock): the version published, and the staging file's mtime it came from.
  const streams = new Map<
    string,
    {
      code: string | null;
      // The last watcher event: the staging file's mtime then, and when it came.
      written: number;
      seen: number;
      busy: boolean;
      pending: boolean;
      last: number;
    }
  >();
  const stagingFile = (name: string) =>
    path.join(
      root,
      "src/design/.staging",
      name === "mock" ? "mock.ts" : `${name}.tsx`,
    );
  const finalFile = (name: string) =>
    name === "mock"
      ? path.join(root, "src/design/mock.ts")
      : path.join(root, "src/design/pages", `${name}.tsx`);
  const streamName = (file: string): string | undefined => {
    const rel = path
      .relative(path.join(root, "src/design"), file)
      .split(path.sep)
      .join("/");
    if (rel === ".staging/mock.ts" || rel === "mock.ts") return "mock";
    const name = /^(?:\.staging|pages)\/([A-Za-z0-9_-]+)\.tsx$/.exec(rel)?.[1];
    return name && !isReservedName(name) ? name : undefined;
  };
  const streamCssDir = path.join(
    projectRoot,
    "node_modules/.appkit-design-stream",
  );
  const streamCssIds = new Set<string>();
  // Words seen in streamed string literals: Tailwind only needs a rebuild
  // when a version brings new ones (possible class names).
  const streamTokens = new Set<string>();
  const newTokens = (code: string) => {
    let added = false;
    for (const m of code.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      for (const token of m[1].split(/\s+/)) {
        if (token && !streamTokens.has(token)) {
          streamTokens.add(token);
          added = true;
        }
      }
    }
    return added;
  };
  let viteServer: ViteDevServer | undefined;
  /** The published version of a page while it streams, else null (from disk). */
  const streamedCode = (name: string) => {
    const code = streams.get(name)?.code ?? null;
    // The staging file is checked too: a builder starting the draft over
    // deletes it, and the watcher reports that a moment later.
    return code !== null &&
      fs.existsSync(stagingFile(name)) &&
      !fs.existsSync(finalFile(name))
      ? code
      : null;
  };
  /**
   * The mock while mock.ts isn't written yet and something streams: what
   * .staging/mock.ts has so far, plus stubs for what streaming pages import.
   */
  const mockCode = (): string | null => {
    if (fs.existsSync(finalFile("mock"))) return null;
    const pages = [...streams.keys()]
      .filter((n) => n !== "mock")
      .map(streamedCode)
      .filter((c): c is string => c !== null);
    const mock = fs.existsSync(stagingFile("mock"))
      ? (streams.get("mock")?.code ?? null)
      : null;
    if (mock === null && pages.length === 0) return null;
    return stubMock(
      mock ?? "",
      pages.flatMap((p) => mockImports(p)),
    );
  };
  let servedMock: string | null = null;
  const reloadFile = async (file: string) => {
    for (const mod of viteServer?.moduleGraph.getModulesByFile(file) ?? []) {
      // Nothing imports it (a page closed): a hot update would find no
      // boundary and reload every open page.
      if (mod.importers.size === 0 && !mod.isSelfAccepting) continue;
      await viteServer?.reloadModule(mod);
    }
  };
  const reloadMock = async () => {
    const code = mockCode();
    if (code === servedMock) return;
    servedMock = code;
    await reloadFile(finalFile("mock"));
  };
  const reloadCss = async () => {
    for (const id of streamCssIds) {
      const mod = await viteServer?.moduleGraph.getModuleById(id);
      if (mod) await viteServer?.reloadModule(mod);
    }
  };
  const isValid = async (code: string) => {
    const vite = (await import("vite")) as typeof import("vite") & {
      transformWithOxc?: (
        code: string,
        file: string,
        opts: object,
      ) => Promise<unknown>;
    };
    try {
      if (vite.transformWithOxc) {
        await vite.transformWithOxc(code, "draft.tsx", { lang: "tsx" });
      } else {
        await vite.transformWithEsbuild(code, "draft.tsx", { loader: "tsx" });
      }
      return true;
    } catch {
      return false;
    }
  };
  /** Publishes the renderable version of a staging file, if it changed. */
  const publish = async (name: string) => {
    const s = streams.get(name);
    if (!s) return;
    const wait = s.last + STREAM_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (fs.existsSync(finalFile(name))) return;
    let raw: string;
    try {
      raw = fs.readFileSync(stagingFile(name), "utf-8");
    } catch {
      return;
    }
    const mock = name === "mock";
    const code = await renderablePartial(raw, isValid, {
      page: !mock,
      boundary: STREAM_MODE === "boundary",
    });
    if (code === null || code === s.code) return;
    s.code = code;
    s.last = Date.now();
    // Styles first, so the version never shows without its classes.
    if (!mock && newTokens(code)) {
      fs.writeFileSync(path.join(streamCssDir, `${name}.tsx`), code);
      await reloadCss();
    }
    if (!mock) await reloadFile(finalFile(name));
    await reloadMock();
    viteServer?.ws.send({
      type: "custom",
      event: "appkit:stream",
      // Times for measuring: written (staging mtime), seen by the watcher, published.
      data: { name, written: s.written, seen: s.seen, published: Date.now() },
    });
  };
  const onStagingChange = async (name: string) => {
    const seen = Date.now();
    let s = streams.get(name);
    if (!s) {
      s = {
        code: null,
        written: 0,
        seen: 0,
        busy: false,
        pending: false,
        last: 0,
      };
      streams.set(name, s);
    }
    s.seen = seen;
    try {
      s.written = fs.statSync(stagingFile(name)).mtimeMs;
    } catch {}
    if (s.busy) {
      s.pending = true;
      return;
    }
    s.busy = true;
    try {
      do {
        s.pending = false;
        await publish(name);
      } while (s.pending);
    } finally {
      s.busy = false;
    }
  };
  /** The finished file landed: Vite hot-updates the module from disk. */
  const onFinal = async (name: string) => {
    const file = finalFile(name);
    let code: string;
    let written: number;
    try {
      code = fs.readFileSync(file, "utf-8");
      written = fs.statSync(file).mtimeMs;
    } catch {
      // Deleted again already (a builder starting the draft over).
      return;
    }
    if (name !== "mock") {
      if (newTokens(code)) {
        fs.writeFileSync(path.join(streamCssDir, `${name}.tsx`), code);
        await reloadCss();
      }
    }
    await reloadMock();
    viteServer?.ws.send({
      type: "custom",
      event: "appkit:stream",
      data: {
        name,
        done: true,
        written,
        seen: Date.now(),
      },
    });
  };

  return {
    name: "appkit-design",
    apply: "serve",

    configResolved(config) {
      root = config.root;
    },

    resolveId: {
      // Before Vite's resolver, which can't find a streamed file not on disk yet.
      order: "pre",
      handler(id, importer) {
        if (
          id.startsWith(ENTRY_PREFIX) ||
          id.startsWith(STREAM_HOST_PREFIX) ||
          id === APP_READY_ID
        ) {
          return `\0${id}`;
        }
        const clean = id.split("?")[0];
        // As the host imports it, or by file (Fast Refresh imports itself).
        const page =
          /^(?:\/src\/design\/pages\/|.*\/src\/design\/pages\/)([A-Za-z0-9_-]+)\.tsx$/.exec(
            clean,
          )?.[1];
        if (
          page &&
          (clean.startsWith("/src/") || clean === finalFile(page)) &&
          streamedCode(page) !== null
        ) {
          return finalFile(page);
        }
        if (
          /^\.\.\/mock(?:\.ts)?$/.test(clean) &&
          importer?.startsWith(path.join(root, "src/design/pages")) &&
          mockCode() !== null
        ) {
          return finalFile("mock");
        }
      },
    },

    transformIndexHtml(_html, ctx) {
      // App pages only: design pages report themselves. Always added, so
      // /design/__status knows the app rendered (and its errors) also without
      // a builder; it posts appkit:app-ready only to builder origins.
      if (resolveDesignPage(root, ctx.path.split("?")[0]) !== undefined) return;
      return [
        {
          tag: "script",
          attrs: { type: "module", src: `/@id/__x00__${APP_READY_ID}` },
          injectTo: "body",
        },
      ];
    },

    async load(id) {
      if (id === `\0${APP_READY_ID}`) return appReadyModule(builderOrigins);
      if (
        id.startsWith(`\0${STREAM_HOST_PREFIX}`) &&
        id.endsWith(ENTRY_SUFFIX)
      ) {
        const name = id.slice(
          STREAM_HOST_PREFIX.length + 1,
          -ENTRY_SUFFIX.length,
        );
        return /^[A-Za-z0-9_-]+$/.test(name)
          ? streamHostModule(name)
          : undefined;
      }
      // A streamed page or mock: its latest renderable version until the
      // finished file is written.
      const loaded = id.split("?")[0];
      const streamed =
        loaded === finalFile("mock")
          ? mockCode()
          : streams.has(path.basename(loaded, ".tsx")) &&
              loaded === finalFile(path.basename(loaded, ".tsx"))
            ? streamedCode(path.basename(loaded, ".tsx"))
            : null;
      if (streamed !== null) return streamed;
      if (!id.startsWith(`\0${ENTRY_PREFIX}`)) return;
      if (!id.endsWith(ENTRY_SUFFIX)) return;
      const file = id.slice(ENTRY_PREFIX.length + 1, -ENTRY_SUFFIX.length);
      if (PAGE_FILE.test(file)) {
        const router = hasReactRouter(root);
        return entryModule(file, builderOrigins, router);
      }
    },

    // A builder deleting a draft (to write it again) would make Vite reload
    // every open page: the module graph still has it, imported by pages since
    // closed. A page showing it keeps its last frame instead.
    hotUpdate({ type, file, modules }) {
      const name = streamName(file);
      if (
        type === "delete" &&
        name &&
        (file === finalFile(name) || file === stagingFile(name))
      ) {
        // Forget its transform, so the next import doesn't get the old file,
        // and that it imported the mock: a hot update of the mock would find
        // this (no longer hot-accepting) importer and reload every page.
        for (const mod of modules) {
          this.environment.moduleGraph.invalidateModule(mod);
          for (const dep of mod.importedModules) dep.importers.delete(mod);
        }
        return [];
      }
      // A finished draft (or mock.ts) landing while nothing imports it yet:
      // with no boundary to update, Vite would reload every open page.
      if (name && file === finalFile(name)) {
        const live = modules.filter(
          (mod) => mod.importers.size > 0 || mod.isSelfAccepting,
        );
        if (live.length < modules.length) return live;
      }
    },

    // Tailwind only scans files for class names: point it at the copies of
    // streamed versions too, so their classes exist before the file does.
    transform: {
      order: "pre",
      handler(code, id) {
        const file = id.split("?")[0];
        if (
          !file.endsWith(".css") ||
          !file.startsWith(path.join(root, "src")) ||
          !code.includes("@import")
        ) {
          return;
        }
        streamCssIds.add(id);
        return `${code}\n@source "${streamCssDir}";\n`;
      },
    },

    configureServer(server) {
      viteServer = server;
      fs.mkdirSync(streamCssDir, { recursive: true });
      const onFile = (file: string) => {
        const name = streamName(file);
        if (!name) return;
        // Never let a draft's file (deleted mid-way, unreadable) take the
        // dev server down.
        const failed = (error: unknown) =>
          server.config.logger.warn(
            `[appkit-design] ${name}: ${String(error)}`,
          );
        if (file === stagingFile(name)) onStagingChange(name).catch(failed);
        else if (file === finalFile(name) && streams.has(name))
          onFinal(name).catch(failed);
      };
      server.watcher?.on("add", onFile);
      server.watcher?.on("change", onFile);
      // A new draft by the same name starts from nothing.
      server.watcher?.on("unlink", (file) => {
        const name = streamName(file);
        if (name && file === stagingFile(name)) streams.delete(name);
      });
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";

        // A streamed page deleted a moment ago (a builder starting the draft
        // over): Vite would serve its cached transform until the watcher
        // reports the delete, and it checks that cache before any plugin.
        const deleted = /^\/src\/design\/pages\/([A-Za-z0-9_-]+)\.tsx$/.exec(
          pathname,
        )?.[1];
        if (
          deleted &&
          streamedCode(deleted) === null &&
          !fs.existsSync(finalFile(deleted))
        ) {
          for (const mod of server.moduleGraph.getModulesByFile(
            finalFile(deleted),
          ) ?? []) {
            server.moduleGraph.invalidateModule(mod);
          }
        }

        // The status endpoint is also read by builder pages on other origins.
        const origin = req.headers?.origin;
        if (
          typeof origin === "string" &&
          builderOrigins.includes(origin) &&
          pathname === STATUS_PATH
        ) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
          if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Methods", "GET, POST");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            res.statusCode = 204;
            res.end();
            return;
          }
        }

        const streamPage = STREAM_ROUTE.exec(pathname)?.[1];
        if (streamPage && !isReservedName(streamPage)) {
          const html = await server.transformIndexHtml(
            req.url ?? pathname,
            pageHtml(
              `Streaming: ${streamPage}`,
              `/@id/__x00__${STREAM_HOST_PREFIX}${streamPage}${ENTRY_SUFFIX}`,
            ),
          );
          res.setHeader("Content-Type", "text/html");
          res.end(html);
          return;
        }

        if (pathname === STATUS_PATH) {
          if (req.method === "POST") {
            // Under AppKit's server, express.json() has already consumed the
            // stream into `req.body`; a bare Vite server leaves it unread.
            let body = (req as { body?: { page?: unknown } }).body;
            if (body === undefined) {
              let raw = "";
              for await (const chunk of req) raw += chunk;
              try {
                body = JSON.parse(raw);
              } catch {}
            }
            const r = body as {
              page?: unknown;
              app?: unknown;
              reset?: unknown;
              ok?: unknown;
              template?: unknown;
              error?: unknown;
            };
            if (typeof r?.page === "string") {
              const version = pageVersion(server.config.root, r.page);
              let entry = pageReports.get(r.page);
              if (r.reset === true || !entry || entry.version !== version) {
                entry = { version, rendered: false, errors: [] };
                pageReports.set(r.page, entry);
              }
              if (typeof r.ok === "boolean") entry.rendered = r.ok;
              if (typeof r.error === "string")
                entry.errors.push({ error: r.error });
            }
            if (typeof r?.app === "string") {
              let entry = appReports.get(r.app);
              if (r.reset === true || !entry) {
                entry = { rendered: false, template: false, errors: [] };
                appReports.set(r.app, entry);
              }
              appPath = r.app;
              if (typeof r.ok === "boolean") {
                entry.rendered = r.ok;
                entry.template = r.template === true;
              }
              if (typeof r.error === "string") {
                entry.errors.push({ error: r.error });
              }
            }
            res.statusCode = 204;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          const indexReport = pageReports.get("index");
          const status = designStatus(
            server.config.root,
            indexReport?.rendered ? indexReport.version : undefined,
          );
          // Per page, for the version on disk: null until a browser reported.
          // Each page is compiled server-side like the index below, so a
          // builder can tell a draft that doesn't build without a browser.
          const pages = await Promise.all(
            status.pages.map(async (page) => {
              const report = pageReports.get(page.name);
              const known =
                !!report &&
                report.version === pageVersion(server.config.root, page.name);
              const file = resolveDesignPage(server.config.root, page.path);
              const pageCompileError = file
                ? await compileGraph(
                    server,
                    `/${path.relative(server.config.root, file).split(path.sep).join("/")}`,
                  )
                : "missing";
              const info = {
                ...page,
                compiled: pageCompileError === undefined,
                ...(pageCompileError ? { compileError: pageCompileError } : {}),
                rendered: known && report.rendered,
                errors: known ? report.errors : null,
              };
              return { ...info, state: pageState(info) };
            }),
          );
          // The app's own pages: compiled server-side from index.html's entry
          // module, rendered and errors as its pages report them.
          const entry = appEntry(server.config.root);
          const appCompileError = entry
            ? await compileGraph(server, entry)
            : undefined;
          const appReport =
            appPath === undefined ? undefined : appReports.get(appPath);
          const app = {
            entry: entry ?? null,
            compiled: !!entry && appCompileError === undefined,
            ...(appCompileError ? { compileError: appCompileError } : {}),
            path: appPath ?? null,
            rendered: appReport?.rendered ?? false,
            template: appReport?.template ?? false,
            errors: appReport ? appReport.errors : null,
          };
          // `ready` needs a browser to paint /design. `compiled` doesn't: it
          // is the index page's server-side build from `pages` above, so an
          // agent can wait on it without a browser.
          const index = resolveDesignPage(server.config.root, "/design");
          const indexPage =
            index && !status.placeholder
              ? pages.find((page) => page.name === "index")
              : undefined;
          const compiled = indexPage?.compiled ?? false;
          const compileError = indexPage?.compileError;
          const waitingFor = !index
            ? "index"
            : status.placeholder
              ? "placeholder"
              : !compiled
                ? "compile"
                : !status.ready
                  ? "paint"
                  : null;
          res.end(
            JSON.stringify({
              ...status,
              pages,
              compiled,
              ...(compileError ? { compileError } : {}),
              waitingFor,
              app,
            }),
          );
          return;
        }

        const file = resolveDesignPage(server.config.root, pathname);
        if (file === undefined) return next();
        if (file === null) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end(
            `No design page for ${pathname}. Add client/src/design/index.tsx (for /design) or client/src/design/pages/<name>.tsx (for /design/<name>) with a default export. "index" and names starting with "__" are reserved for page files.`,
          );
          return;
        }
        try {
          const name = path.basename(file, path.extname(file));
          const title = name === "index" ? "Design" : `Design: ${name}`;
          const rel = path
            .relative(path.join(server.config.root, "src/design"), file)
            .split(path.sep)
            .join("/");
          const html = await server.transformIndexHtml(
            req.url ?? pathname,
            pageHtml(title, `/@id/__x00__${ENTRY_PREFIX}${rel}${ENTRY_SUFFIX}`),
          );
          res.setHeader("Content-Type", "text/html");
          res.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

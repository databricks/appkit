import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { Plugin, ViteDevServer } from "vite";

import {
  DRAFT_ROUTE,
  dataAppkitSchema,
  draftFile,
  hydratorModule,
  hydratorTag,
  listDrafts,
  streamDraft,
  themeCss,
} from "./drafts";

/**
 * One virtual entry per page: `virtual:appkit-design-page:<file>.mjs`. The
 * `.mjs` keeps @vitejs/plugin-react from treating the entry as a `.tsx`
 * component module and injecting Fast Refresh code that imports it by id.
 */
const ENTRY_PREFIX = "virtual:appkit-design-page:";
const ENTRY_SUFFIX = ".mjs";
/** Hydrator injected into served drafts: `virtual:appkit-draft-hydrator:<name>.mjs`. */
const HYDRATOR_PREFIX = "virtual:appkit-draft-hydrator:";
/** Script added to the app's own pages (not /design) to post appkit:app-ready. */
const APP_READY_ID = "virtual:appkit-app-ready.mjs";

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
const BLOCK_SCHEMA_PATH = "/design/__data-appkit.schema.json";
const DRAFT_THEME_PATH = "/design/drafts/theme.css";
/** Stable URL of the draft hydrator, for drafts streamed from elsewhere. */
const HYDRATOR_PATH = "/design/drafts/__hydrator.js";
/** Vite's default dev CORS origins (localhost), kept when builders are added. */
const LOCALHOST_ORIGIN =
  /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const EXTENSIONS = [".tsx", ".jsx"];

/**
 * `pages/index.tsx` would collide with the root page, `pages/drafts.tsx` with
 * the drafts at `/design/drafts/<name>`, and `__*` with the plugin's own
 * endpoints (`/design/__status`), so those names aren't pages.
 */
const isReservedName = (name: string) =>
  name === "index" || name === "drafts" || name.startsWith("__");

/** Page files the browser entry may route to (reserved names excluded). */
const PAGE_GLOBS = [
  "/src/design/index.{tsx,jsx}",
  "/src/design/pages/*.{tsx,jsx}",
  "!/src/design/pages/index.{tsx,jsx}",
  "!/src/design/pages/drafts.{tsx,jsx}",
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

/** Modification time of the index page, or undefined when there is none. */
function indexVersion(clientRoot: string): number | undefined {
  const index = resolveDesignPage(clientRoot, "/design");
  return index ? fs.statSync(index).mtimeMs : undefined;
}

/**
 * `/design/__status`: ready once `index.tsx` exists, isn't the template
 * placeholder, and has painted in a browser since it last changed
 * (`paintedVersion` is the file's mtime when that paint was reported).
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
    paintedVersion !== undefined && paintedVersion === indexVersion(clientRoot);
  return {
    ready: real && painted,
    placeholder,
    pages: listDesignPages(clientRoot),
  };
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

// Resolves once the page shows its real content: fonts loaded, no fetch in
// flight, no DOM change for QUIET_MS, then two frames (painted).
async function settled(isCurrent) {
  await document.fonts?.ready;
  const start = performance.now();
  while (isCurrent()) {
    const capped = performance.now() - start > SETTLE_CAP_MS;
    const quiet = performance.now() - lastMutation >= QUIET_MS;
    if (host.blockers === 0 && (capped || (pendingFetches === 0 && quiet))) break;
    await sleep(50);
  }
  await frame();
  await frame();
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
import * as initial from "/src/design/${file}";
import.meta.glob("/src/index.css", { eager: true });

const ORIGINS = ${JSON.stringify(builderOrigins)};
const pageName = (file) =>
  file.startsWith("/src/design/pages/") ? file.slice(18).replace(/\\.[jt]sx$/, "") : "index";
const pages = Object.keys(import.meta.glob(${JSON.stringify(PAGE_GLOBS)}))
  .map((file) => ({ name: pageName(file), path: pageName(file) === "index" ? "/design" : "/design/" + pageName(file) }))
  .sort((a, b) => (a.name === "index" ? -1 : b.name === "index" ? 1 : a.name.localeCompare(b.name)));

${SETTLE_SNIPPET}
function postStatus(name, ok) {
  fetch("${STATUS_PATH}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: name, ok }),
  }).catch(() => {});
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

// Reports readiness only from a successful render. A render error is caught
// here (and shown) instead of being reported; the server is told, so a
// failure in any component the page uses un-readies it.
function withReady(mod, name) {
  const placeholder = mod.designPlaceholder === true;
  return class DesignReady extends Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
      return { error };
    }
    componentDidMount() {
      this.settle();
    }
    componentDidUpdate() {
      this.settle();
    }
    settle() {
      current = { name, ok: !this.state.error && !placeholder };
      if (this.state.error) postStatus(name, false);
      else schedule();
    }
    render() {
      if (this.state.error) {
        return createElement(
          "pre",
          { style: { padding: 16, whiteSpace: "pre-wrap", color: "#b91c1c" } },
          "Design page failed to render: " + (this.state.error?.message ?? String(this.state.error)),
        );
      }
      return createElement(Suspense, { fallback: createElement(Pending) }, createElement(mod.default));
    }
  };
}

// Hot edits re-render in place without remounting; once React has applied
// the edit, wait for the page to settle again before reporting it.
// (Adding or removing the placeholder export reloads the page instead.)
import.meta.hot?.on("vite:afterUpdate", () => setTimeout(schedule, 50));
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

let run = 0;
function schedule() {
  const mine = ++run;
  settled(() => mine === run).then(() => {
    if (mine !== run || host.blockers > 0) return;
    if (document.querySelector("[${TEMPLATE_HOME_ATTR}]")) return;
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
// E.g. the default home page being replaced by the real one.
import.meta.hot?.on("vite:afterUpdate", () => setTimeout(schedule, 50));
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
  // Drafts live in the app folder (the dev server's working directory).
  const projectRoot = process.cwd();
  const draftsDir = path.join(projectRoot, "drafts");
  // mtime of the index page when a browser last reported painting it.
  let paintedVersion: number | undefined;
  // Render errors reported by the hydrator, per draft, for one version of it.
  const draftErrors = new Map<
    string,
    {
      version: number;
      errors: { block: number; component: string; error: string }[];
    }
  >();
  // Drafts with a response still streaming, and the version last streamed in
  // full: a change notification (page reload) is only needed after both.
  const streamingDrafts = new Map<string, number>();
  const streamedVersion = new Map<string, number>();
  const draftVersion = (name: string) => {
    const file = draftFile(projectRoot, name);
    return file ? fs.statSync(file).mtimeMs : -1;
  };

  return {
    name: "appkit-design",
    apply: "serve",

    // A draft streamed by the builder (from its own origin) loads the
    // hydrator and its imports from this dev server: allow the builder origins
    // next to Vite's default localhost ones.
    config() {
      if (builderOrigins.length === 0) return;
      return {
        server: { cors: { origin: [...builderOrigins, LOCALHOST_ORIGIN] } },
      };
    },

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      if (
        id.startsWith(ENTRY_PREFIX) ||
        id.startsWith(HYDRATOR_PREFIX) ||
        id === APP_READY_ID
      ) {
        return `\0${id}`;
      }
    },

    transformIndexHtml(_html, ctx) {
      // App pages only: design pages report appkit:design-ready themselves.
      if (builderOrigins.length === 0) return;
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
      if (id.startsWith(`\0${HYDRATOR_PREFIX}`) && id.endsWith(ENTRY_SUFFIX)) {
        const draft = id.slice(
          HYDRATOR_PREFIX.length + 1,
          -ENTRY_SUFFIX.length,
        );
        if (/^[A-Za-z0-9_-]+$/.test(draft)) {
          return hydratorModule(draft, builderOrigins, STATUS_PATH);
        }
        return;
      }
      if (!id.startsWith(`\0${ENTRY_PREFIX}`)) return;
      if (!id.endsWith(ENTRY_SUFFIX)) return;
      const file = id.slice(ENTRY_PREFIX.length + 1, -ENTRY_SUFFIX.length);
      if (PAGE_FILE.test(file)) {
        const router = hasReactRouter(root);
        return entryModule(file, builderOrigins, router);
      }
    },

    configureServer(server) {
      // Not Vite's watcher: for a changed .html it matches no module, Vite
      // sends a full reload, and in middleware mode that reloads every page
      // (a draft mid-stream, the app) on each write.
      const onDraftChange = (file: string | null) => {
        const name = /^([A-Za-z0-9_-]+)\.html$/.exec(file ?? "")?.[1];
        // Writes during a stream reach the page through the stream itself,
        // and a late event for content already streamed needs no reload.
        if (
          name &&
          !(streamingDrafts.get(name) ?? 0) &&
          draftVersion(name) !== streamedVersion.get(name)
        ) {
          server.ws.send({
            type: "custom",
            event: "appkit:draft-changed",
            data: { draft: name },
          });
        }
      };
      let draftsWatcher: fs.FSWatcher | undefined;
      const watchDrafts = () => {
        if (draftsWatcher || !fs.existsSync(draftsDir)) return;
        draftsWatcher = fs.watch(draftsDir, (_, file) => onDraftChange(file));
        draftsWatcher.unref();
      };
      watchDrafts();
      // drafts/ may only be created once the app is running.
      fs.watch(projectRoot, watchDrafts).unref();
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";

        // The plugin's own endpoints are also used by builder pages on other
        // origins (a streamed draft posts errors, loads the hydrator).
        const origin = req.headers?.origin;
        if (
          typeof origin === "string" &&
          builderOrigins.includes(origin) &&
          (pathname === STATUS_PATH ||
            pathname === HYDRATOR_PATH ||
            pathname === DRAFT_THEME_PATH ||
            pathname === BLOCK_SCHEMA_PATH)
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

        if (pathname === HYDRATOR_PATH) {
          const draft = new URL(req.url ?? "", "http://x").searchParams.get(
            "draft",
          );
          const name =
            draft && /^[A-Za-z0-9_-]+$/.test(draft) ? draft : "stream";
          res.statusCode = 302;
          res.setHeader(
            "Location",
            `/@id/__x00__${HYDRATOR_PREFIX}${name}${ENTRY_SUFFIX}`,
          );
          res.end();
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
            const report = body as {
              draft?: unknown;
              reset?: unknown;
              block?: unknown;
              component?: unknown;
              error?: unknown;
            };
            if (typeof report?.draft === "string") {
              const version = draftVersion(report.draft);
              let entry = draftErrors.get(report.draft);
              if (report.reset === true || entry?.version !== version) {
                entry = { version, errors: [] };
                draftErrors.set(report.draft, entry);
              }
              if (typeof report.error === "string") {
                entry.errors.push({
                  block: typeof report.block === "number" ? report.block : -1,
                  component: String(report.component ?? ""),
                  error: report.error,
                });
              }
            }
            if (body?.page === "index") {
              paintedVersion =
                (body as { ok?: unknown }).ok === false
                  ? undefined
                  : indexVersion(server.config.root);
            }
            res.statusCode = 204;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          const files = listDrafts(projectRoot);
          const drafts: {
            name: string;
            path: string | null;
            streamed?: true;
            errors: { block: number; component: string; error: string }[];
          }[] = files.map((d) => {
            const entry = draftErrors.get(d.name);
            return {
              ...d,
              errors:
                entry?.version === draftVersion(d.name) ? entry.errors : [],
            };
          });
          // Drafts streamed from elsewhere (no file here) report errors too.
          for (const [name, entry] of draftErrors) {
            if (files.some((d) => d.name === name) || entry.version !== -1) {
              continue;
            }
            drafts.push({
              name,
              path: null,
              streamed: true,
              errors: entry.errors,
            });
          }
          const status = designStatus(server.config.root, paintedVersion);
          // `ready` needs a browser to paint /design. `compiled` doesn't: it
          // builds the index page (and resolves its imports) server-side, so
          // an agent can wait on it without a browser.
          const index = resolveDesignPage(server.config.root, "/design");
          let compiled = false;
          let compileError: string | undefined;
          if (index && !status.placeholder) {
            compileError = await compileGraph(
              server,
              `/${path.relative(server.config.root, index).split(path.sep).join("/")}`,
            );
            compiled = compileError === undefined;
          }
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
              compiled,
              ...(compileError ? { compileError } : {}),
              waitingFor,
              drafts,
              blockSchema: BLOCK_SCHEMA_PATH,
              theme: DRAFT_THEME_PATH,
              hydrator: HYDRATOR_PATH,
            }),
          );
          return;
        }

        if (pathname === DRAFT_THEME_PATH) {
          let css = "";
          try {
            css = fs.readFileSync(
              createRequire(
                path.join(server.config.root, "package.json"),
              ).resolve("@databricks/appkit-ui/styles.css"),
              "utf-8",
            );
          } catch {}
          res.setHeader("Content-Type", "text/css; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(themeCss(css));
          return;
        }

        if (pathname === BLOCK_SCHEMA_PATH) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(dataAppkitSchema(), null, 2));
          return;
        }

        const draft = DRAFT_ROUTE.exec(pathname)?.[1];
        if (draft) {
          const file = draftFile(projectRoot, draft);
          if (!file) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/plain");
            res.end(`No draft at drafts/${draft}.html.`);
            return;
          }
          streamingDrafts.set(draft, (streamingDrafts.get(draft) ?? 0) + 1);
          streamDraft(
            file,
            hydratorTag(
              `/@id/__x00__${HYDRATOR_PREFIX}${draft}${ENTRY_SUFFIX}`,
            ),
            res,
            (mtime) => {
              streamingDrafts.set(draft, (streamingDrafts.get(draft) ?? 1) - 1);
              streamedVersion.set(draft, mtime);
            },
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

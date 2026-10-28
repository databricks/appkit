import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { Plugin } from "vite";

/** One virtual entry per page: `virtual:appkit-design-page:<file>`. */
const ENTRY_PREFIX = "virtual:appkit-design-page:";
const PAGE_FILE = /^(index|pages\/[A-Za-z0-9_-]+)\.(tsx|jsx)$/;
const DESIGN_ROUTE = /^\/design(?:\/([A-Za-z0-9_-]+))?\/?$/;
const STATUS_PATH = "/design/__status";
const EXTENSIONS = [".tsx", ".jsx"];

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
  if (!match) return null;
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
        .filter((n): n is string => !!n)
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
): { ready: boolean; pages: DesignPageInfo[] } {
  const index = resolveDesignPage(clientRoot, "/design");
  const real =
    !!index && !PLACEHOLDER_EXPORT.test(fs.readFileSync(index, "utf-8"));
  const painted =
    paintedVersion !== undefined && paintedVersion === indexVersion(clientRoot);
  return { ready: real && painted, pages: listDesignPages(clientRoot) };
}

/** Whether the app can import `react-router` (the template ships it). */
function hasReactRouter(clientRoot: string): boolean {
  try {
    createRequire(path.join(clientRoot, "package.json")).resolve(
      "react-router",
    );
    return true;
  } catch {
    return false;
  }
}

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
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import * as initial from "/src/design/${file}";
import.meta.glob("/src/index.css", { eager: true });

const ORIGINS = ${JSON.stringify(builderOrigins)};
const pageName = (file) =>
  /\\/index\\.[jt]sx$/.test(file) ? "index" : file.replace(/^.*\\/pages\\//, "").replace(/\\.[jt]sx$/, "");
const files = Object.keys(
  import.meta.glob(["/src/design/index.{tsx,jsx}", "/src/design/pages/*.{tsx,jsx}"]),
);
const pages = files
  .map((file) => ({ name: pageName(file), path: pageName(file) === "index" ? "/design" : "/design/" + pageName(file) }))
  .sort((a, b) => (a.name === "index" ? -1 : b.name === "index" ? 1 : a.name.localeCompare(b.name)));

function afterPaint(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function reportReady(name) {
  fetch("${STATUS_PATH}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: name }),
  }).catch(() => {});
  const target = window.parent !== window ? window.parent : window.opener;
  if (!target) return;
  for (const origin of ORIGINS) {
    target.postMessage({ type: "appkit:design-ready", version: 1, page: name, pages }, origin);
  }
}

let current;
function withReady(mod, name) {
  function DesignReady() {
    useEffect(() => {
      current = mod.designPlaceholder === true ? undefined : name;
      if (current) afterPaint(() => reportReady(name));
    }, []);
    return createElement(mod.default);
  }
  return DesignReady;
}

// Hot edits re-render in place; report the repaint so the status catches up.
// (Adding or removing the placeholder export reloads the page instead.)
import.meta.hot?.on("vite:afterUpdate", () => {
  if (current) afterPaint(() => reportReady(current));
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

const lazyPages = import.meta.glob(["/src/design/index.{tsx,jsx}", "/src/design/pages/*.{tsx,jsx}"]);
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
  // mtime of the index page when a browser last reported painting it.
  let paintedVersion: number | undefined;

  return {
    name: "appkit-design",
    apply: "serve",

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      if (id.startsWith(ENTRY_PREFIX)) return `\0${id}`;
    },

    load(id) {
      if (!id.startsWith(`\0${ENTRY_PREFIX}`)) return;
      const file = id.slice(ENTRY_PREFIX.length + 1);
      if (PAGE_FILE.test(file)) {
        return entryModule(file, builderOrigins, hasReactRouter(root));
      }
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";

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
            if (body?.page === "index") {
              paintedVersion = indexVersion(server.config.root);
            }
            res.statusCode = 204;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(
            JSON.stringify(designStatus(server.config.root, paintedVersion)),
          );
          return;
        }

        const file = resolveDesignPage(server.config.root, pathname);
        if (file === undefined) return next();
        if (file === null) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end(
            `No design page for ${pathname}. Add client/src/design/index.tsx (for /design) or client/src/design/pages/<name>.tsx (for /design/<name>) with a default export.`,
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
            pageHtml(title, `/@id/__x00__${ENTRY_PREFIX}${rel}`),
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

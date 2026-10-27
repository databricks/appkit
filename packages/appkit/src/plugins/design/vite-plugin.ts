import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";

const ENTRY_ID = "virtual:appkit-design-page";
const ENTRY_URL = `/@id/__x00__${ENTRY_ID}`;
const DESIGN_ROUTE = /^\/design(?:\/([A-Za-z0-9_-]+))?\/?$/;
const EXTENSIONS = [".tsx", ".jsx"];

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

// Globs are root-relative (root = the client dir). The page is picked at
// runtime from the URL; the server already 404s pages that don't exist.
const ENTRY_MODULE = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import.meta.glob("/src/index.css", { eager: true });
// Eager: design pages are few, and a lazy import can race the dev server's
// first dependency-optimization reload.
const pages = import.meta.glob(
  ["/src/design/index.{tsx,jsx}", "/src/design/pages/*.{tsx,jsx}"],
  { eager: true },
);
const name = location.pathname.replace(/^\\/design\\/?/, "").replace(/\\/$/, "");
const key = Object.keys(pages).find((file) =>
  name
    ? file.replace(/^\\/src\\/design\\/pages\\//, "").replace(/\\.[jt]sx$/, "") === name
    : /^\\/src\\/design\\/index\\.[jt]sx$/.test(file),
);
const { default: Page } = pages[key];
createRoot(document.getElementById("root")).render(createElement(Page));
`;

const pageHtml = (title: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${ENTRY_URL}"></script>
  </body>
</html>
`;

/**
 * Serves `/design` (the default export of `client/src/design/index.tsx`) and
 * `/design/<name>` (`client/src/design/pages/<name>.tsx`) at full size, with
 * the app's own styles.
 *
 * @internal
 */
export function designVitePlugin(): Plugin {
  return {
    name: "appkit-design",
    apply: "serve",

    resolveId(id) {
      if (id === ENTRY_ID) return `\0${id}`;
    },

    load(id) {
      if (id === `\0${ENTRY_ID}`) return ENTRY_MODULE;
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
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
          const html = await server.transformIndexHtml(
            req.url ?? pathname,
            pageHtml(title),
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

import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";

/** One virtual entry per page: `virtual:appkit-design-page:<file>`. */
const ENTRY_PREFIX = "virtual:appkit-design-page:";
const PAGE_FILE = /^(index|pages\/[A-Za-z0-9_-]+)\.(tsx|jsx)$/;
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

// Imports only the requested page (root-relative; root = the client dir), so
// an unfinished draft elsewhere in the folder can't break this one.
const entryModule = (file: string) => `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Page from "/src/design/${file}";
import.meta.glob("/src/index.css", { eager: true });
createRoot(document.getElementById("root")).render(createElement(Page));
`;

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
      if (id.startsWith(ENTRY_PREFIX)) return `\0${id}`;
    },

    load(id) {
      if (!id.startsWith(`\0${ENTRY_PREFIX}`)) return;
      const file = id.slice(ENTRY_PREFIX.length + 1);
      if (PAGE_FILE.test(file)) return entryModule(file);
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

import type { Plugin } from "vite";

const CANVAS_ID = "virtual:appkit-design-canvas";
const url = (id: string) => `/@id/__x00__${id}`;

// Globs are root-relative (root = the client dir), so `/src/design` is
// `client/src/design`. appkit-ui's stylesheet gives the canvas its theme even
// if the app doesn't import it; the app's `index.css` (optional, an empty glob
// is a no-op) brings the app's own theme and Tailwind build.
const canvasModule = (builderOrigins: string[]) => `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "@databricks/appkit-ui/styles.css";
import { DesignCanvas } from "@databricks/appkit-ui/react/design";
import.meta.glob("/src/index.css", { eager: true });
const modules = import.meta.glob("/src/design/**/*.{tsx,jsx}", { eager: true });
createRoot(document.getElementById("root")).render(
  createElement(DesignCanvas, { modules, builderOrigins: ${JSON.stringify(builderOrigins)} }),
);
`;

const CANVAS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Design canvas</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${url(CANVAS_ID)}"></script>
  </body>
</html>
`;

/**
 * Serves the `/design` canvas. The element picker lives only there; app pages
 * are left untouched.
 *
 * @internal
 */
export function designVitePlugin({
  builderOrigins,
}: {
  builderOrigins: string[];
}): Plugin {
  return {
    name: "appkit-design",
    apply: "serve",

    resolveId(id) {
      if (id === CANVAS_ID) return `\0${id}`;
    },

    load(id) {
      if (id === `\0${CANVAS_ID}`) return canvasModule(builderOrigins);
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== "/design" && pathname !== "/design/") return next();
        try {
          const html = await server.transformIndexHtml(
            req.url ?? "/design",
            CANVAS_HTML,
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

import type { Plugin } from "vite";

const CANVAS_ID = "virtual:appkit-design-canvas";
const PICKER_ID = "virtual:appkit-design-picker";
const url = (id: string) => `/@id/__x00__${id}`;

// Globs are root-relative (root = the client dir), so `/src/design` is
// `client/src/design`. `index.css` is optional; an empty glob is a no-op.
const CANVAS_MODULE = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DesignCanvas } from "@databricks/appkit-ui/react/beta";
import.meta.glob("/src/index.css", { eager: true });
const modules = import.meta.glob("/src/design/**/*.{tsx,jsx}", { eager: true });
createRoot(document.getElementById("root")).render(createElement(DesignCanvas, { modules }));
`;

const PICKER_MODULE = `
import { mountDesignPicker } from "@databricks/appkit-ui/react/beta";
mountDesignPicker();
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
 * Serves the `/design` canvas and injects the element picker into every HTML
 * page Vite transforms (the app and the canvas alike).
 *
 * @internal
 */
export function designVitePlugin(): Plugin {
  return {
    name: "appkit-design",
    apply: "serve",

    resolveId(id) {
      if (id === CANVAS_ID || id === PICKER_ID) return `\0${id}`;
    },

    load(id) {
      if (id === `\0${CANVAS_ID}`) return CANVAS_MODULE;
      if (id === `\0${PICKER_ID}`) return PICKER_MODULE;
    },

    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module", src: url(PICKER_ID) },
          injectTo: "body",
        },
      ];
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

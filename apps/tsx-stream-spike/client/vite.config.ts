import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: { hmr: { port: 24680 } },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ],
    exclude: ["@databricks/appkit-ui"],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    // The "development" export condition points at appkit-ui source, which needs its own aliases.
    alias: {
      "@databricks/appkit-ui": path.resolve(
        __dirname,
        "../../../packages/appkit-ui/dist",
      ),
    },
  },
});

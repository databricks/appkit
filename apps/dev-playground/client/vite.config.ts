import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    middlewareMode: true,
  },
  build: {
    outDir: path.resolve(__dirname, "./dist"),
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === "development",
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ],
    // Consumed as built dist via the alias below — don't pre-bundle them.
    exclude: ["@databricks/appkit", "@databricks/appkit-ui"],
  },
  resolve: {
    // Dedupe keeps a single React/recharts instance across the app and the
    // linked workspace package — without it, the pnpm symlink pulls a second
    // copy and hooks throw.
    dedupe: ["react", "react-dom", "recharts"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // @databricks/appkit-ui's `exports` has a `development` condition
      // pointing at its TS source, which uses the package's own internal
      // `@/` alias that this app's vite can't resolve. Pin the built dist of
      // the pnpm-linked package (kept fresh by its build:watch) so the dev
      // server consumes the local build, same as production/deploy.
      "@databricks/appkit-ui": path.resolve(
        __dirname,
        "../node_modules/@databricks/appkit-ui/dist",
      ),
    },
  },
});

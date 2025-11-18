import path from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
  ],
  server: {
    middlewareMode: true,
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@databricks/apps/react": path.resolve(
        __dirname,
        "../../../packages/frontend/react/src/index.ts",
      ),
      "@databricks/apps/js": path.resolve(
        __dirname,
        "../../../packages/frontend/js/src/index.ts",
      ),
    },
  },
});

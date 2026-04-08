import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ],
    exclude: ["@databricks/appkit-ui", "@databricks/appkit"],
  },
  server: {
    hmr: {
      port: 24679,
    },
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    preserveSymlinks: true,
    alias: {
      "@databricks/appkit-ui": path.resolve(
        __dirname,
        "../../packages/appkit-ui/dist",
      ),
    },
  },
});

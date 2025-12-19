import path from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: process.env.NODE_ENV !== "development",
    }),
  ],
  server: {
    hmr: {
      port: 24679,
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ],
    exclude: ["@databricks/appkit-ui", "@databricks/appkit"],
  },
  resolve: {
    dedupe: ["react", "react-dom", "recharts"],
    preserveSymlinks: true,
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@databricks/appkit-ui": path.resolve(
        __dirname,
        "../../../packages/appkit-ui/dist",
      ),
    },
  },
});

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
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ],
    exclude: ["@databricks/app-kit-ui", "@databricks/app-kit"],
  },
  resolve: {
    dedupe: ["react", "react-dom", "recharts"],
    preserveSymlinks: true,
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@databricks/app-kit-ui": path.resolve(
        __dirname,
        "../../../packages/app-kit-ui/dist",
      ),
    },
  },
});

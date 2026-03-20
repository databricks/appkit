import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, "client/index.tsx"),
      formats: ["iife"],
      name: "AppKitInspector",
      fileName: () => "inspector-client.js",
    },
    outDir: resolve(__dirname, "../../../dist"),
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

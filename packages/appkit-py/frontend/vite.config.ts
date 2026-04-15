import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Resolve @databricks/appkit-ui from the local monorepo build output.
// The build script (scripts/build_frontend.sh) ensures appkit-ui is built first.
const appkitUiDist = path.resolve(__dirname, "../../appkit-ui/dist");

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, "../src/appkit_py/static"),
    emptyOutDir: true,
  },
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
    alias: {
      "@databricks/appkit-ui": appkitUiDist,
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

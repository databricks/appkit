import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Mirror the alias trick from dev-playground: route `@databricks/appkit-ui`
// straight at the built `dist/` so we never traverse the package's
// `"development"` export condition (which uses internal `@/*` source
// aliases that this app's Vite resolver doesn't know about).
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

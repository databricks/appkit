import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Deploy-time vite config. The local one in apps/app-with-task aliases
// `@databricks/appkit-ui` to the monorepo's
// `packages/appkit-ui/dist`, which doesn't exist once the app is
// uploaded standalone. Here we let Node's `node_modules` resolution do
// the work — the deploy script swaps a `file:./databricks-appkit-ui-*.tgz`
// into the dependency list so the package shows up in node_modules
// like any other npm install.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});

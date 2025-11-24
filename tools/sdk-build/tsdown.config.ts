import { defineConfig } from "tsdown";
import { writeBrowserStub } from "./write-stub";

export default defineConfig([
  {
    name: "server",
    entry: "packages/backend/index.ts",
    outDir: "dist/server",
    hash: false,
    platform: "node",
    minify: true,
    dts: true,
    sourcemap: false,
    clean: true,
    external: ["vite", "@vitejs/plugin-react"],
    onSuccess: (config) => writeBrowserStub(config.outDir),
    copy: [
      "packages/backend/server/src/index.html",
      {
        from: "packages/backend/server/src/index.html",
        to: "dist/server/index.html",
      },
      "packages/backend/server/src/wait.html",
      {
        from: "packages/backend/server/src/wait.html",
        to: "dist/server/wait.html",
      },
      "packages/backend/server/src/denied.html",
      {
        from: "packages/backend/server/src/denied.html",
        to: "dist/server/denied.html",
      },
    ],
  },
  {
    name: "js",
    entry: "packages/frontend/js/src/index.ts",
    outDir: "dist/js",
    platform: "browser",
    minify: true,
    dts: true,
    sourcemap: false,
    clean: true,
    hash: false,
  },
  {
    name: "react",
    entry: "packages/frontend/react/src/index.ts",
    outDir: "dist/react",
    hash: false,
    platform: "browser",
    minify: true,
    dts: true,
    sourcemap: false,
    clean: true,
    external: ["react", "react-dom", "recharts"],
  },
]);

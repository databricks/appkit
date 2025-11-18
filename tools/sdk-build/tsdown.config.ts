import { defineConfig } from "tsdown";
import { writeBrowserStub } from "./write-stub";

export default defineConfig([
  {
    name: "server",
    entry: "packages/backend/index.ts",
    outDir: "dist/server",
    platform: "node",
    minify: true,
    dts: true,
    sourcemap: false,
    clean: true,
    external: ["vite", "@vitejs/plugin-react"],
    onSuccess: (config) => writeBrowserStub(config.outDir),
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
    platform: "browser",
    minify: true,
    dts: true,
    sourcemap: false,
    clean: true,
    external: ["react", "react-dom"],
    hash: false,
  },
]);

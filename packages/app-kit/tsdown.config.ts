import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: false,
    name: "@databricks/app-kit",
    entry: "src/index.ts",
    outDir: "dist",
    hash: false,
    format: "esm",
    platform: "node",
    minify: false,
    dts: {
      resolve: true,
    },
    sourcemap: false,
    skipNodeModulesBundle: true,
    clean: false,
    unbundle: true,
    noExternal: ["shared"],
    external: ["vite", "@vitejs/plugin-react"],
    tsconfig: "./tsconfig.json",
    copy: [
      {
        from: "src/server/index.html",
        to: "dist/server/index.html",
      },
      {
        from: "src/server/wait.html",
        to: "dist/server/wait.html",
      },
      {
        from: "src/server/denied.html",
        to: "dist/server/denied.html",
      },
    ],
  },
  {
    publint: false,
    name: "@databricks/app-kit/browser",
    entry: "src/browser.ts",
    outDir: "dist",
    hash: false,
    format: "esm",
    platform: "browser",
    minify: false,
    dts: {
      resolve: true,
    },
    sourcemap: false,
    clean: false,
    noExternal: ["shared"],
    tsconfig: "./tsconfig.json",
  },
]);

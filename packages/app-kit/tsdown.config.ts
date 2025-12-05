import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
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
    clean: false,
    unbundle: true,
    noExternal: ["shared"],
    external: (id) => {
      // Bundle "shared" workspace package, externalize everything else from node_modules
      if (id === "shared" || id.startsWith("shared/")) return false;
      return /^[^./]/.test(id) || id.includes("/node_modules/");
    },
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
    exports: {
      devExports: "development",
    },
  },
]);

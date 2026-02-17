import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
    name: "@databricks/lakebase",
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
    noExternal: [],
    external: (id) => {
      // Bundle all internal modules
      if (id.startsWith("@/")) return false;
      // Externalize all npm packages
      return /^[^./]/.test(id) || id.includes("/node_modules/");
    },
    tsconfig: "./tsconfig.json",
  },
]);

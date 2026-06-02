import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
    attw: {
      profile: "strict",
      level: "error",
    },
    name: "@databricks/lakebase",
    entry: "src/index.ts",
    outDir: "dist",
    hash: false,
    format: ["esm", "cjs"],
    platform: "node",
    minify: false,
    dts: {
      resolver: "oxc",
    },
    sourcemap: false,
    clean: false,
    unbundle: true,
    noExternal: [],
    outExtensions: ({ format }) => ({
      js: format === "cjs" ? ".cjs" : ".js",
    }),
    external: (id) => {
      // Bundle all internal modules
      if (id.startsWith("@/")) return false;
      // Externalize all npm packages
      return /^[^./]/.test(id) || id.includes("/node_modules/");
    },
    tsconfig: "./tsconfig.json",
  },
]);

import { defineConfig } from "tsdown";
import typescriptNext from "typescript-next";

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
    // Strip JSDoc from the JS output (rolldown 1.2 keeps it by default). The
    // .d.ts files keep their JSDoc; legal comments and annotations stay.
    outputOptions: { comments: { jsdoc: false } },
    dts: {
      resolver: "oxc",
      // TypeScript 7.0 lacks the declaration-emit API; emit .d.ts with the pinned
      // 7.1 beta until 7.1.0 is stable.
      generator: "tsgo",
      tsgo: { moduleUrl: typescriptNext },
    },
    sourcemap: false,
    clean: false,
    unbundle: true,
    outExtensions: ({ format }) => ({
      js: format === "cjs" ? ".cjs" : ".js",
    }),
    deps: {
      neverBundle: (id) => {
        // Bundle all internal modules
        if (id.startsWith("@/")) return false;
        // Externalize all npm packages
        return /^[^./]/.test(id) || id.includes("/node_modules/");
      },
    },
    tsconfig: "./tsconfig.json",
  },
]);

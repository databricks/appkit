import { defineConfig } from "tsdown";
import typescriptNext from "typescript-next";

export default defineConfig([
  {
    publint: true,
    attw: {
      profile: "esm-only",
      level: "error",
    },
    name: "@databricks/appkit",
    entry: [
      "src/index.ts",
      "src/beta.ts",
      "src/testing/index.ts",
      "src/tsdown/index.ts",
      "src/type-generator/index.ts",
    ],
    outDir: "dist",
    hash: false,
    format: "esm",
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
    outExtensions: () => ({
      js: ".js",
    }),
    deps: {
      alwaysBundle: ["shared"],
      neverBundle: (id) => {
        // Bundle "shared" workspace package and @/ path aliases
        if (id === "shared" || id.startsWith("shared/")) return false;
        if (id.startsWith("@/")) return false;
        return /^[^./]/.test(id) || id.includes("/node_modules/");
      },
    },
    tsconfig: "./tsconfig.json",
    copy: [
      {
        from: "src/plugins/server/remote-tunnel/*.html",
        to: "dist/plugins/server/remote-tunnel",
        flatten: true,
      },
    ],
  },
]);

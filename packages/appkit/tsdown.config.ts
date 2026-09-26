import { defineConfig } from "tsdown";

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
    dts: {
      resolver: "oxc",
    },
    sourcemap: false,
    clean: false,
    unbundle: true,
    outExtensions: () => ({
      js: ".js",
    }),
    noExternal: ["shared"],
    external: (id) => {
      // Bundle "shared" workspace package and @/ path aliases
      if (id === "shared" || id.startsWith("shared/")) return false;
      if (id.startsWith("@/")) return false;
      return /^[^./]/.test(id) || id.includes("/node_modules/");
    },
    tsconfig: "./tsconfig.json",
    copy: [
      {
        from: "src/plugins/server/remote-tunnel/*.html",
        to: "dist/plugins/server/remote-tunnel",
        flatten: true,
      },
      {
        // Self-contained App Analytics build served at /_analytics/v1/sdk.js.
        // Built first because @databricks/app-analytics is a devDependency;
        // the build fails if the file is missing.
        from: "../app-analytics/dist/browser/sdk.js",
        to: "dist/plugins/server/app-analytics",
        flatten: true,
      },
    ],
  },
]);

import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
    name: "@databricks/appkit",
    // `./type-generator` is a public subpath export consumed cross-package by the
    // `appkit generate-types` CLI via a dynamic import Rolldown can't see. It must
    // be its own entry so the names the CLI imports at runtime
    // (generateFromEntryPoint — which additively emits metric-view types — and
    // generateServingTypes) are preserved under unbundle tree-shaking. Without it,
    // the subpath's runtime exports collapse to only the names appkit's own Vite
    // plugins import — silently dropping the CLI's.
    entry: ["src/index.ts", "src/beta.ts", "src/type-generator/index.ts"],
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
    ],
  },
]);

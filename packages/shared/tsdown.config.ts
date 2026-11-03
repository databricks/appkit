import { defineConfig } from "tsdown";
import typescriptNext from "typescript-next";

export default defineConfig({
  name: "shared",
  entry: ["src/index.ts", "src/cli/index.ts", "src/workspace-client/index.ts"],
  outDir: "dist",
  minify: false,
  format: "esm",
  platform: "node", // Required for bin commands
  sourcemap: false,
  unbundle: true,
  // Strip JSDoc from the JS output (rolldown 1.2 keeps it by default). The
  // .d.ts files keep their JSDoc; legal comments and annotations stay.
  outputOptions: { comments: { jsdoc: false } },
  dts: {
    // TypeScript 7.0 lacks the declaration-emit API; emit .d.ts with the pinned
    // 7.1 beta until 7.1.0 is stable.
    generator: "tsgo",
    tsgo: { moduleUrl: typescriptNext },
  },
  clean: false,
  hash: false,
  deps: {
    neverBundle: (id) => {
      // Keep npm packages external in both JavaScript and declaration output.
      if (id.startsWith("@/")) return false;
      return /^[^./]/.test(id) || id.includes("/node_modules/");
    },
  },
  tsconfig: "./tsconfig.json",
  outExtensions: () => ({
    js: ".js",
  }),
  exports: {
    devExports: "development",
    // tsdown 0.23 turns entries with a shebang into a `bin` field; the CLI
    // ships through packages/shared/bin instead.
    bin: false,
  },
});

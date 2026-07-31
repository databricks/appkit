import { defineConfig } from "tsdown";

export default defineConfig({
  name: "shared",
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    // Node-only path resolvers. Needs its own entry (→ generated
    // "./cli/commands/cache-paths" export) because appkit imports it as a bare
    // cross-package specifier that tsx resolves via shared's exports map at
    // runtime (dev-playground's `development`-condition source run) — tsconfig
    // paths don't apply there. Kept OUT of the client-safe root barrel because
    // it imports node:path (would break the docs client webpack bundle).
    "src/cli/commands/cache-paths.ts",
  ],
  outDir: "dist",
  minify: false,
  format: "esm",
  platform: "node", // Required for bin commands
  sourcemap: false,
  unbundle: true,
  dts: true,
  clean: false,
  hash: false,
  skipNodeModulesBundle: true,
  external: [/^@databricks\//],
  tsconfig: "./tsconfig.json",
  outExtensions: () => ({
    js: ".js",
  }),
  exports: {
    devExports: "development",
  },
});

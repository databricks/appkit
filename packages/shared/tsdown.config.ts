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
    //
    // DO NOT REMOVE this export: without it the dev-playground server fails to
    // boot with ERR_PACKAGE_PATH_NOT_EXPORTED, which times out the "Playground
    // Integration Tests" (Playwright) CI job. Build/typecheck/unit tests all
    // still pass, so only that job catches its absence.
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

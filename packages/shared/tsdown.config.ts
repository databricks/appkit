import { defineConfig } from "tsdown";

export default defineConfig({
  name: "shared",
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    // Node-only path resolvers, exposed as the "shared/cache-paths" subpath so
    // appkit can import them without pulling node: builtins into the
    // client-safe root barrel. Must be a tsdown entry or the exports plugin
    // (exports.devExports below) drops the "./cache-paths" export on rebuild.
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

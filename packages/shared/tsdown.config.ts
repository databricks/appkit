import { defineConfig } from "tsdown";

export default defineConfig({
  name: "shared",
  entry: ["src/index.ts", "src/cli/index.ts"],
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
  exports: {
    devExports: "development",
  },
});

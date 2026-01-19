import { defineConfig } from "tsdown";

export default defineConfig({
  name: "shared",
  entry: "src/index.ts",
  outDir: "dist",
  minify: false,
  format: "esm",
  platform: "node",
  sourcemap: false,
  unbundle: true,
  dts: true,
  clean: false,
  hash: false,
  skipNodeModulesBundle: true,
  tsconfig: "./tsconfig.json",
  exports: {
    devExports: "development",
  },
});

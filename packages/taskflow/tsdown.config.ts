import { defineConfig } from "tsdown";

export default defineConfig({
  name: "@databricks/taskflow",
  entry: "src/index.ts",
  outDir: "dist",
  format: "esm",
  platform: "neutral",
  minify: false,
  dts: true,
  sourcemap: false,
  clean: false,
  unbundle: true,
  skipNodeModulesBundle: true,
  tsconfig: "./tsconfig.json",
  exports: {
    devExports: "development",
  },
});

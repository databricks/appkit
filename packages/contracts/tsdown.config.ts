import { defineConfig } from "tsdown";

export default defineConfig({
  name: "contracts",
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: false,
  hash: false,
  unbundle: true,
  skipNodeModulesBundle: true,
  external: [/^@bufbuild\//],
  tsconfig: "./tsconfig.json",
  outExtensions: () => ({
    js: ".js",
  }),
  exports: {
    devExports: "development",
  },
});

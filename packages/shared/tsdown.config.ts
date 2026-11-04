import { defineConfig } from "tsdown";

export default defineConfig({
  name: "shared",
  entry: ["src/index.ts", "src/cli/index.ts", "src/workspace-client/index.ts"],
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
  external: (id) => {
    // Keep npm packages external in both JavaScript and declaration output.
    if (id.startsWith("@/")) return false;
    return /^[^./]/.test(id) || id.includes("/node_modules/");
  },
  tsconfig: "./tsconfig.json",
  outExtensions: () => ({
    js: ".js",
  }),
  exports: {
    devExports: "development",
  },
});

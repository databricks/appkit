import { defineConfig } from "tsdown";

export default defineConfig([
  {
    name: "@databricks/app-kit-ui",
    entry: ["src/js/index.ts", "src/react/index.ts"],
    outDir: "dist",
    platform: "browser",
    minify: false,
    dts: {
      resolve: true,
    },
    clean: false,
    hash: false,
    unbundle: true,
    format: "esm",
    skipNodeModulesBundle: true,
    noExternal: ["shared"],
    external: ["react", "react-dom", "recharts"],
    tsconfig: "./tsconfig.json",
    exports: {
      devExports: "development",
    },
  },
]);

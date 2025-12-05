import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
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
    noExternal: ["shared"],
    external: (id) => {
      // Bundle "shared" workspace package and @/ path aliases
      if (id === "shared" || id.startsWith("shared/")) return false;
      if (id.startsWith("@/")) return false;
      return /^[^./]/.test(id) || id.includes("/node_modules/");
    },
    tsconfig: "./tsconfig.json",
    exports: {
      devExports: "development",
    },
  },
]);

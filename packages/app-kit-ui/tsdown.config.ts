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
    copy: [
      {
        from: "src/react/styles/globals.css",
        to: "dist/styles.css",
      },
    ],
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
      customExports(pkg, context) {
        const dist = "./dist/styles.css";
        const development = "./src/react/styles/globals.css";

        pkg["./styles.css"] = context.isPublish
          ? dist
          : {
              development,
              default: dist,
            };

        return pkg;
      },
    },
  },
]);

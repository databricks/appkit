import { defineConfig } from "tsdown";
import typescriptNext from "typescript-next";

export default defineConfig([
  {
    publint: true,
    attw: {
      profile: "esm-only",
      level: "error",
      excludeEntrypoints: ["./styles.css"],
    },
    name: "@databricks/appkit-ui",
    entry: [
      "src/js/index.ts",
      "src/js/beta.ts",
      "src/react/index.ts",
      "src/react/beta.ts",
    ],
    outDir: "dist",
    platform: "browser",
    minify: false,
    // Strip JSDoc from the JS output (rolldown 1.2 keeps it by default). The
    // .d.ts files keep their JSDoc; legal comments and annotations stay.
    outputOptions: { comments: { jsdoc: false } },
    dts: {
      resolver: "oxc",
      // TypeScript 7.0 lacks the declaration-emit API; emit .d.ts with the pinned
      // 7.1 beta until 7.1.0 is stable.
      generator: "tsgo",
      tsgo: { moduleUrl: typescriptNext },
    },
    copy: [
      {
        from: "src/react/styles/globals.css",
        to: "dist",
        rename: "styles.css",
      },
    ],
    clean: false,
    hash: false,
    unbundle: true,
    format: "esm",
    deps: {
      alwaysBundle: ["shared"],
      neverBundle: (id) => {
        // Bundle "shared" workspace package and @/ path aliases
        if (id === "shared" || id.startsWith("shared/")) return false;
        if (id.startsWith("@/")) return false;
        return /^[^./]/.test(id) || id.includes("/node_modules/");
      },
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

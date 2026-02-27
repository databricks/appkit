import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
    name: "@databricks/appkit",
    entry: "src/index.ts",
    outDir: "dist",
    hash: false,
    format: "esm",
    platform: "node",
    minify: false,
    dts: {
      resolver: "oxc",
    },
    sourcemap: false,
    clean: false,
    unbundle: true,
    outExtensions: () => ({
      js: ".js",
    }),
    noExternal: ["shared"],
    external: (id) => {
      // Bundle "shared" workspace package and @/ path aliases
      if (id === "shared" || id.startsWith("shared/")) return false;
      if (id.startsWith("@/")) return false;
      return /^[^./]/.test(id) || id.includes("/node_modules/");
    },
    tsconfig: "./tsconfig.json",
    copy: [
      {
        from: "src/plugins/server/remote-tunnel/index.html",
        to: "dist/plugins/server/remote-tunnel/index.html",
      },
      {
        from: "src/plugins/server/remote-tunnel/wait.html",
        to: "dist/plugins/server/remote-tunnel/wait.html",
      },
      {
        from: "src/plugins/server/remote-tunnel/denied.html",
        to: "dist/plugins/server/remote-tunnel/denied.html",
      },
    ],
  },
]);

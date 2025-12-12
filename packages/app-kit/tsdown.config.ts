import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
    name: "@databricks/app-kit",
    entry: "src/index.ts",
    outDir: "dist",
    hash: false,
    format: "esm",
    platform: "node",
    minify: false,
    dts: {
      resolve: true,
    },
    sourcemap: false,
    clean: false,
    unbundle: true,
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
        from: "src/server/remote-tunnel/index.html",
        to: "dist/server/remote-tunnel/index.html",
      },
      {
        from: "src/server/remote-tunnel/wait.html",
        to: "dist/server/remote-tunnel/wait.html",
      },
      {
        from: "src/server/remote-tunnel/denied.html",
        to: "dist/server/remote-tunnel/denied.html",
      },
    ],
  },
]);

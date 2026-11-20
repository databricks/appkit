import { defineConfig } from "tsdown";

export default defineConfig([
  {
    publint: true,
    attw: {
      // Subpath exports require the modern Node resolution algorithm.
      profile: "node16",
      level: "error",
    },
    name: "@databricks/app-analytics",
    entry: ["src/index.ts", "src/react/index.tsx"],
    outDir: "dist",
    hash: false,
    format: ["esm", "cjs"],
    // Client SDK — "neutral" so the bundle assumes neither Node built-ins nor
    // a specific bundler. Revisit if a Node-only entry is added later.
    platform: "neutral",
    minify: false,
    dts: {
      resolver: "oxc",
    },
    sourcemap: false,
    // Avoid carrying removed modules or source maps into the published tarball.
    clean: true,
    unbundle: true,
    noExternal: [],
    outExtensions: ({ format }) => ({
      js: format === "cjs" ? ".cjs" : ".js",
    }),
    // Externalize npm packages; relative imports are bundled.
    external: (id) => /^[^./]/.test(id) || id.includes("/node_modules/"),
    tsconfig: "./tsconfig.json",
  },
]);

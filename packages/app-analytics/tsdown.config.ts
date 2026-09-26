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
  {
    // Self-contained browser build that starts the default client on load.
    // Not a package export: @databricks/appkit copies it into its own dist and
    // serves it at /_analytics/v1/sdk.js when App telemetry is on.
    name: "@databricks/app-analytics (browser)",
    entry: { sdk: "src/auto.ts" },
    outDir: "dist/browser",
    hash: false,
    format: "esm",
    platform: "browser",
    minify: true,
    dts: false,
    sourcemap: false,
    // The package config above already cleans dist/, and tsdown cleans every
    // config's output before it builds any of them.
    clean: false,
    // One file with no imports, so web-vitals is bundled in. Minifying drops
    // its license headers, so the banner keeps the attribution.
    noExternal: ["web-vitals"],
    inlineOnly: ["web-vitals"],
    banner:
      "/*! @databricks/app-analytics | Apache-2.0 | includes web-vitals, Copyright Google LLC, Apache-2.0 */",
    outExtensions: () => ({
      js: ".js",
    }),
    tsconfig: "./tsconfig.json",
  },
]);

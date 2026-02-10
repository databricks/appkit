import { defineConfig } from "tsdown";

export default defineConfig([
  {
    name: "dev-playground",
    entry: "server/index.ts",
    outDir: "build",
    format: "esm",
    platform: "node",
    minify: false,
    sourcemap: false,
    clean: false,
    tsconfig: "./tsconfig.json", // Explicitly reference tsconfig with decorator settings
  },
]);

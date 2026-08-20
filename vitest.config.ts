import path from "node:path";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/apps/**",
        "**/*.config.*",
        "**/*.test.*",
        "**/tests/**",
        "**/template/**",
        "**/docs/**",
      ],
    },
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./packages/appkit-ui/src"),
          },
        },
        test: {
          name: "appkit-ui",
          root: "./packages/appkit-ui",
          environment: "jsdom",
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "appkit",
          root: "./packages/appkit",
          environment: "node",
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "lakebase",
          root: "./packages/lakebase",
          environment: "node",
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "shared",
          root: "./packages/shared",
          environment: "node",
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "dev-playground",
          root: "./apps/dev-playground",
          environment: "node",
          // tests/ holds Playwright specs. Vitest's default `**/*.spec.ts`
          // glob would collect them and they fail on import with "Playwright
          // Test did not expect test.describe() to be called here". They run
          // via `pnpm test:integration`.
          exclude: ["**/node_modules/**", "**/dist/**", "tests/**"],
        },
      },
    ],
  },
});

import path from "node:path";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Some suites import large module graphs inside tests and hooks (lazy
// `await import`), so under CPU load with coverage the 5s/10s defaults time
// out on module transforms rather than on the code under test.
const slowImportTimeouts = { testTimeout: 30_000, hookTimeout: 30_000 };

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
        plugins: [tsconfigPaths()],
        test: {
          name: "playground",
          root: "./apps/dev-playground",
          environment: "node",
          ...slowImportTimeouts,
          // Playwright owns tests/*.spec.ts; these are isolated server unit tests.
          include: ["server/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "tools",
          root: "./tools",
          environment: "node",
          include: ["*.test.ts"],
        },
      },
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
          ...slowImportTimeouts,
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
          ...slowImportTimeouts,
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

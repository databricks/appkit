import react from "@vitejs/plugin-react";
import path from "node:path";
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
      ],
    },
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./packages/app-kit-ui/src"),
          },
        },
        test: {
          name: "app-kit-ui",
          root: "./packages/app-kit-ui",
          environment: "jsdom",
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "app-kit",
          root: "./packages/app-kit",
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
    ],
  },
});

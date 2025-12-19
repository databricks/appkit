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
          name: "shared",
          root: "./packages/shared",
          environment: "node",
        },
      },
    ],
  },
});

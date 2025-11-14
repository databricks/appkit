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
      ],
    },
    projects: [
      {
        plugins: [react()],
        test: {
          name: "frontend",
          root: "./packages/frontend",
          environment: "jsdom",
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "backend",
          root: "./packages/backend",
          environment: "node",
        },
      },
    ],
  },
});

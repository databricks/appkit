import { defineEvalConfig } from "@databricks/appkit/beta";

/**
 * Root eval config for the dev-playground. `webServer` lets `appkit agent eval`
 * boot the app on demand (reusing an already-running dev server) instead of
 * requiring it to be started by hand.
 */
export default defineEvalConfig({
  // Mirror playwright.config.ts so the readiness poll matches the port the app
  // actually binds (dotenv is loaded by the CLI entrypoint).
  baseUrl: `http://localhost:${process.env.DATABRICKS_APP_PORT || 8000}`,
  webServer: {
    // Monorepo fixture command; a template project would use `npm run dev`.
    command: "pnpm --filter=dev-playground dev",
    timeoutMs: 90_000,
  },
});

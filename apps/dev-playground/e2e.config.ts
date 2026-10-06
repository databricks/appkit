import { web } from "@e2edev/web";
import type { E2EConfig } from "e2e";

import { appEnv, userHeaders } from "./e2e/identity/env";

export default {
  tests: "e2e/**/*.e2e.ts",
  targets: [
    {
      engine: web({
        url: "http://127.0.0.1:0",
        readyUrl: "http://127.0.0.1:{port}/health",
        // Every browser request carries the signed-in user, as the Apps proxy would.
        headers: userHeaders,
        command: {
          executable: "node",
          args: ["--import", "tsx", "server.ts"],
          cwd: "e2e/identity/app",
          env: appEnv,
          startupTimeout: 120_000,
          log: ".e2e/logs/identity-app.log",
        },
      }),
    },
  ],
  // Identity checks share one SP and one user; keep the order and the log readable.
  workers: 1,
} satisfies E2EConfig;

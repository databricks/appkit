import "reflect-metadata";
import {
  analytics,
  createApp,
  type FilePolicy,
  files,
  genie,
  PolicyDeniedError,
  server,
  serving,
  WRITE_ACTIONS,
} from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
// TODO: re-enable once vector-search is exported from @databricks/appkit
// import { vectorSearch } from "@databricks/appkit";
import { lakebaseExamples } from "./lakebase-examples-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

function createMockClient() {
  const client = new WorkspaceClient({
    host: "http://localhost",
    token: "e2e",
    authType: "pat",
  });
  client.currentUser.me = async () => ({ id: "e2e-test-user" });
  return client;
}

/**
 * Policy test harness.
 *
 * Each volume key below is backed by a `DATABRICKS_VOLUME_*` env var in
 * `app.yaml` — all seven point at the same underlying UC volume path.
 * The different policies are evaluated in-process, so the shared path
 * is fine; the logical volume key is what drives enforcement.
 *
 * Exercises every policy shape the plugin ships with, plus the new
 * "no policy configured" default (v0.21.0+).
 */
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? "";

/** Writes allowed only for the configured admin user ID; reads open. */
const adminOnly: FilePolicy = (action, _resource, user) => {
  if (WRITE_ACTIONS.has(action)) {
    return ADMIN_USER_ID !== "" && user.id === ADMIN_USER_ID;
  }
  return true;
};

createApp({
  plugins: [
    server({ autoStart: false }),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    genie({
      spaces: { demo: process.env.DATABRICKS_GENIE_SPACE_ID ?? "placeholder" },
    }),
    lakebaseExamples(),
    files({
      volumes: {
        // baseline: everything allowed
        allow_all: { policy: files.policy.allowAll() },
        // read-only: uploads/mkdir/delete return 403
        public_read: { policy: files.policy.publicRead() },
        // locked: every action returns 403 (yes, even list)
        deny_all: { policy: files.policy.denyAll() },
        // SP can do everything, users can only read (docs example)
        sp_only: {
          policy: files.policy.any(
            (_action, _resource, user) => !!user.isServicePrincipal,
            files.policy.publicRead(),
          ),
        },
        // writes gated on ADMIN_USER_ID env var, reads open
        admin_only: { policy: adminOnly },
        // drop-box: writes only, reads denied (not(publicRead))
        write_only: { policy: files.policy.not(files.policy.publicRead()) },
        // no explicit policy → falls back to publicRead() + startup warning
        implicit: {},
      },
    }),
    serving(),
    // TODO: re-enable once vector-search is exported from @databricks/appkit
    // vectorSearch({
    //   indexes: {
    //     demo: {
    //       indexName:
    //         process.env.DATABRICKS_VS_INDEX_NAME ?? "catalog.schema.index",
    //       columns: ["id", "text", "title"],
    //       queryType: "hybrid",
    //     },
    //   },
    // }),
  ],
  ...(process.env.APPKIT_E2E_TEST && { client: createMockClient() }),
}).then((appkit) => {
  appkit.server
    .extend((app) => {
      app.get("/sp", (_req, res) => {
        appkit.analytics
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });

      app.get("/obo", (req, res) => {
        appkit.analytics
          .asUser(req)
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("OBO Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });

      /**
       * Echoes the user identity the server sees. Useful for confirming
       * that `x-forwarded-user` is forwarded in the deployed environment.
       */
      app.get("/whoami", (req, res) => {
        res.json({
          xForwardedUser: req.header("x-forwarded-user") ?? null,
          adminUserId: ADMIN_USER_ID || null,
          isAdmin:
            ADMIN_USER_ID !== "" &&
            req.header("x-forwarded-user") === ADMIN_USER_ID,
        });
      });

      /**
       * Programmatic API smoke test — service principal path.
       *
       * All probes are read-only and deny-oriented, so nothing is
       * written to the UC volume. Expected results:
       * - `allow_all.list`      → ok (real SDK call)
       * - `deny_all.list`       → PolicyDeniedError (deny wins even for SP)
       * - `write_only.list`     → PolicyDeniedError (reads denied)
       *
       * Confirms `isServicePrincipal: true` is set on the SP path.
       */
      app.get("/policy/sp", async (_req, res) => {
        const results = await runProbes([
          ["allow_all", "list", () => appkit.files("allow_all").list()],
          ["deny_all", "list", () => appkit.files("deny_all").list()],
          ["write_only", "list", () => appkit.files("write_only").list()],
        ]);
        res.json({ identity: "service_principal", results });
      });

      /**
       * Programmatic API smoke test — OBO (on-behalf-of user) path.
       *
       * All probes are read-only; no files are written. Expected:
       * - `public_read.list` → ok (reads open)
       * - `deny_all.list`    → PolicyDeniedError
       * - `sp_only.list`     → ok (publicRead arm of `any()` allows reads)
       */
      app.get("/policy/obo", async (req, res) => {
        const results = await runProbes([
          [
            "public_read",
            "list",
            () => appkit.files("public_read").asUser(req).list(),
          ],
          [
            "deny_all",
            "list",
            () => appkit.files("deny_all").asUser(req).list(),
          ],
          ["sp_only", "list", () => appkit.files("sp_only").asUser(req).list()],
        ]);
        res.json({
          identity: "user",
          xForwardedUser: req.header("x-forwarded-user") ?? null,
          results,
        });
      });
    })
    .start();
});

type ProbeResult = {
  volume: string;
  action: string;
  ok: boolean;
  denied: boolean;
  error?: string;
};

async function runProbes(
  probes: Array<[string, string, () => Promise<unknown>]>,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const [volume, action, fn] of probes) {
    try {
      await fn();
      out.push({ volume, action, ok: true, denied: false });
    } catch (error) {
      const denied = error instanceof PolicyDeniedError;
      out.push({
        volume,
        action,
        ok: false,
        denied,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

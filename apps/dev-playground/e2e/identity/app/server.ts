import { analytics, createApp, lakebase, server } from "@databricks/appkit";
import { agents } from "@databricks/appkit/beta";

const WHOAMI_SQL = "SELECT current_user() AS identity";

// The e2e runner appends to one log across runs; tests read from the last marker.
console.log("e2e-identity-app: boot");

/** Identity probes for the execution-identity e2e suite. Every route answers `{ identity }`. */
createApp({
  plugins: [agents(), analytics(), lakebase(), server()],
  async onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      type Req = Parameters<typeof appkit.asUser>[0];
      const probe = (path: string, fn: (req: Req) => Promise<unknown>) =>
        app.get(path, async (req, res) => {
          try {
            res.json({ identity: await fn(req) });
          } catch (error) {
            const err = error as Error & { code?: string };
            res.status(500).json({ code: err.code, error: err.message });
          }
        });
      const identity = (rows: unknown) =>
        (rows as { identity: string }[])[0]?.identity;

      probe("/e2e/default", async () =>
        identity(await appkit.analytics.query(WHOAMI_SQL)),
      );
      probe("/e2e/as-user-block", (req) =>
        appkit
          .asUser(req)
          .run(async (kit) => identity(await kit.analytics.query(WHOAMI_SQL))),
      );
      probe("/e2e/as-user-oneshot", async (req) =>
        identity(await appkit.asUser(req).analytics.query(WHOAMI_SQL)),
      );
      probe(
        "/e2e/lakebase",
        async () =>
          (await appkit.lakebase.query("SELECT current_user AS identity"))
            .rows[0]?.identity,
      );
      probe(
        "/e2e/lakebase-as-user",
        async (req) =>
          (
            await appkit
              .asUser(req)
              .lakebase.query("SELECT current_user AS identity")
          ).rows[0]?.identity,
      );
    });
  },
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

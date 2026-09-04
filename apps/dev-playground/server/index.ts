import "reflect-metadata";
import {
  analytics,
  createApp,
  createWorkspaceClient,
  type FilePolicy,
  files,
  genie,
  lakebase,
  PolicyDeniedError,
  server,
  serving,
  WRITE_ACTIONS,
} from "@databricks/appkit";
import { agents, aiSearch, LakebaseThreadStore } from "@databricks/appkit/beta";

import { lakebaseExamples } from "./lakebase-examples-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

function createMockClient() {
  const client = createWorkspaceClient({
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

/**
 * OBO demo policy: deny anything running as the SP (including the dev
 * fallback when no `x-forwarded-access-token` is present). Only real
 * end-users (`isServicePrincipal: false`) get through.
 */
const usersOnly: FilePolicy = (_action, _resource, user) => {
  return user.isServicePrincipal !== true;
};

createApp({
  plugins: [
    server(),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    genie({
      spaces: { demo: process.env.DATABRICKS_GENIE_SPACE_ID ?? "placeholder" },
    }),
    ...(process.env.LAKEBASE_ENDPOINT ? [lakebase()] : []),
    lakebaseExamples(),
    files({
      volumes: {
        // Smart Dashboard saved views land here. Backed by
        // DATABRICKS_VOLUME_FILES (see app.yaml / .env). Open policy for
        // the demo — production apps should narrow this.
        files: { policy: files.policy.allowAll() },
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
        // OBO demo volume — auth: "on-behalf-of-user" routes HTTP traffic
        // through `runInUserContext` so SDK calls execute with the end
        // user's access token. The `usersOnly` policy denies any traffic
        // that wasn't authenticated via `x-forwarded-access-token`.
        obo_demo: {
          auth: "on-behalf-of-user",
          policy: usersOnly,
        },
      },
    }),
    serving(),
    agents({
      // Every agent lives under server/agents/<id>/ — code agents as agent.ts
      // (helper, supervisor, sql_analyst, dashboard_pilot), markdown agents as
      // agent.md (query, insights, anomaly, autocomplete). `query` (markdown
      // dispatcher) delegates to the code `sql_analyst` + `dashboard_pilot` to
      // wire the /smart-dashboard route. `insights` and `anomaly` are ephemeral
      // markdown agents auto-fired by the route's AgentSidebar. `helper` is the
      // conversational default for the bare `/agent` route (the markdown agents
      // are dispatchers or ephemeral and don't make sense as the landing agent).
      defaultAgent: "helper",
      // Persist threads across restarts when a Lakebase is bound (same
      // LAKEBASE_ENDPOINT signal the lakebase plugin uses above). The store
      // self-bootstraps its tables on setup; without Lakebase we fall back to
      // the in-memory store, so local dev needs no database.
      ...(process.env.LAKEBASE_ENDPOINT
        ? { threadStore: new LakebaseThreadStore() }
        : {}),
    }),
    aiSearch({
      indexes: {
        demo: {
          columns: ["id", "text", "title"],
          queryType: "hybrid",
        },
      },
    }),
  ],
  ...(process.env.APPKIT_E2E_TEST && { client: createMockClient() }),
  async onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      // ── Lakebase OBO routes (per-user pool, RLS enforced) ──────────

      if ("lakebase" in appkit) {
        // GET /api/lakebase-examples/raw/my-products — RLS-filtered list
        app.get("/api/lakebase-examples/raw/my-products", async (req, res) => {
          try {
            const result = await appkit.lakebase
              .asUser(req)
              .query(
                "SELECT * FROM raw_example.products ORDER BY created_at DESC",
              );
            res.json(result.rows);
          } catch (error: unknown) {
            const err = error as Error;
            res.status(500).json({
              error: "Failed to fetch user products",
              message: err.message,
            });
          }
        });

        // POST /api/lakebase-examples/raw/my-products — create as user
        // created_by is set to current_user by the per-user pool's identity
        app.post("/api/lakebase-examples/raw/my-products", async (req, res) => {
          try {
            const { name, category, price, stock } = req.body;

            const result = await appkit.lakebase.asUser(req).query(
              `INSERT INTO raw_example.products (name, category, price, stock, created_by)
                   VALUES ($1, $2, $3, $4, current_user) RETURNING *`,
              [name, category, Number(price), Number(stock)],
            );
            res.json(result.rows[0]);
          } catch (error: unknown) {
            const err = error as Error;
            res.status(500).json({
              error: "Failed to create product",
              message: err.message,
            });
          }
        });
      }

      // ── Analytics examples ──────────

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

      /**
       * Smart-Dashboard saved-view storage.
       *
       * Writes a PNG snapshot of the dashboard plus a sidecar JSON of the
       * filter/highlight state into the `files` volume
       * (`DATABRICKS_VOLUME_FILES` — `/Volumes/<catalog>/<schema>/...`).
       * Body is JSON with a base64-encoded PNG so we avoid adding a
       * multipart library just for this route. The ~33% size overhead is
       * fine for demo payloads.
       *
       * This endpoint is only reachable AFTER the `save_view` approval
       * gate has resolved client-side — the agent's text confirmation
       * depends on the client first upload the screenshot, then POSTing
       * the approval.
       */
      app.post("/api/dashboard/save-view", async (req, res) => {
        const body = req.body as {
          name?: string;
          description?: string;
          filters?: Record<string, unknown>;
          highlights?: unknown[];
          pngBase64?: string;
        } | null;

        if (
          !body?.name ||
          typeof body.name !== "string" ||
          !body.pngBase64 ||
          typeof body.pngBase64 !== "string"
        ) {
          res
            .status(400)
            .json({ error: "Missing required fields: name, pngBase64." });
          return;
        }

        const slug = toSlug(body.name);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const baseName = `saved-views/${timestamp}_${slug}`;
        const pngPath = `${baseName}.png`;
        const metaPath = `${baseName}.json`;

        const pngBytes = decodeDataUrlOrBase64(body.pngBase64);
        if (!pngBytes) {
          res.status(400).json({ error: "pngBase64 is not valid base64." });
          return;
        }

        const metadata = {
          name: body.name,
          description: body.description ?? null,
          filters: body.filters ?? {},
          highlights: body.highlights ?? [],
          savedAt: new Date().toISOString(),
          savedBy: req.header("x-forwarded-user") ?? "unknown",
          pngPath,
        };

        try {
          const volume = appkit.files("files").asUser(req);
          await volume.upload(pngPath, pngBytes, { overwrite: true });
          await volume.upload(
            metaPath,
            Buffer.from(JSON.stringify(metadata, null, 2), "utf8"),
            { overwrite: true },
          );
          res.json({
            volumePath: pngPath,
            metaPath,
            bytes: pngBytes.length,
            metadata,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Upload failed: ${msg}` });
        }
      });

      /**
       * Lists saved views in the `files` volume.
       *
       * Pairs the `.png` and `.json` entries into a single record per
       * saved view; strips files that don't conform to the
       * `<timestamp>_<slug>.(png|json)` convention.
       */
      app.get("/api/dashboard/saved-views", async (req, res) => {
        try {
          const volume = appkit.files("files").asUser(req);
          let entries: Awaited<ReturnType<typeof volume.list>>;
          try {
            entries = await volume.list("saved-views");
          } catch (err) {
            // Fresh volume — the `saved-views/` subdirectory only exists
            // after the first save. Treat "not found" as an empty list so
            // the panel renders cleanly instead of showing a 500.
            if (isNotFoundError(err)) {
              res.json({ views: [] });
              return;
            }
            throw err;
          }
          const pngs = new Map<string, (typeof entries)[number]>();
          const metas = new Map<string, (typeof entries)[number]>();
          for (const e of entries) {
            if (e.path.endsWith(".png")) {
              pngs.set(e.path.replace(/\.png$/, ""), e);
            } else if (e.path.endsWith(".json")) {
              metas.set(e.path.replace(/\.json$/, ""), e);
            }
          }
          const views = await Promise.all(
            Array.from(pngs.entries())
              .filter(([base]) => metas.has(base))
              .sort(([a], [b]) => (a < b ? 1 : -1))
              .map(async ([base, pngEntry]) => {
                try {
                  const metaText = await volume.read(`${base}.json`);
                  const metaJson =
                    typeof metaText === "string"
                      ? metaText
                      : new TextDecoder().decode(metaText);
                  const parsed = JSON.parse(metaJson) as Record<
                    string,
                    unknown
                  >;
                  return {
                    pngPath: pngEntry.path,
                    metaPath: `${base}.json`,
                    metadata: parsed,
                  };
                } catch {
                  return null;
                }
              }),
          );
          res.json({ views: views.filter((v) => v !== null) });
        } catch (err) {
          console.error("[saved-views] list failed:", err);
          const msg = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: msg });
        }
      });

      /**
       * Streams the PNG bytes of a saved view so `<img src>` tags in the
       * UI can render thumbnails without exposing a general-purpose file
       * download endpoint. Path is the volume-relative key returned by
       * /api/dashboard/saved-views.
       */
      app.get("/api/dashboard/saved-view-png", async (req, res) => {
        const path = req.query.path;
        if (typeof path !== "string" || !path.endsWith(".png")) {
          res
            .status(400)
            .json({ error: "path query param required, .png only" });
          return;
        }
        try {
          const volume = appkit.files("files").asUser(req);
          /**
           * Databricks `FilesAPI.download` returns a wrapper:
           *   { contents: ReadableStream, "content-type": string, ... }
           * NOT the stream itself. We must unwrap `.contents` and drain it
           * before writing to the Express response. Using the server-reported
           * content-type (our captures are JPEG under a `.png` key, historical).
           */
          const response = (await volume.download(path)) as unknown as {
            contents?: ReadableStream<Uint8Array>;
            "content-type"?: string;
          };
          const stream = response.contents;
          if (!stream) {
            res.status(404).json({ error: "empty download response" });
            return;
          }
          const chunks: Uint8Array[] = [];
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          const body = Buffer.concat(chunks);
          res.setHeader(
            "Content-Type",
            response["content-type"] ?? "image/png",
          );
          res.setHeader("Cache-Control", "private, max-age=60");
          res.end(body);
        } catch (err) {
          console.error("[saved-view-png] fetch failed:", err);
          const msg = err instanceof Error ? err.message : String(err);
          res.status(404).json({ error: msg });
        }
      });

      /**
       * Per-volume OBO mode demo. Hits the `obo_demo` volume — configured
       * with `auth: "on-behalf-of-user"` — to confirm:
       *
       * 1. With a forwarded user identity, HTTP routes execute the SDK
       *    call as the end user (request goes through `runInUserContext`).
       * 2. Without `x-forwarded-access-token`, production returns 401;
       *    development falls back to the SP and the `usersOnly` policy
       *    rejects with 403.
       * 3. Programmatic `appkit.files("obo_demo").asUser(req).list()` runs
       *    inside the same user context.
       *
       * Returns the HTTP status, body, and the user identity the server
       * observes — so the policy-matrix client can render a clear
       * pass/fail panel.
       */
      app.get("/policy/obo-volume", async (req, res) => {
        const xForwardedUser = req.header("x-forwarded-user") ?? null;
        const xForwardedToken =
          (req.header("x-forwarded-access-token")?.length ?? 0) > 0;

        const programmatic: ProbeResult[] = await runProbes([
          [
            "obo_demo",
            "list",
            () => appkit.files("obo_demo").asUser(req).list(),
          ],
        ]);

        res.json({
          mode: "on-behalf-of-user",
          xForwardedUser,
          xForwardedAccessTokenPresent: xForwardedToken,
          programmatic,
        });
      });
    });
  },
}).catch(console.error);

/**
 * Heuristic match for Databricks Files API's "directory not found" error.
 * The SDK surfaces it as a wrapped Error whose message contains the
 * `FILES_API_DIRECTORY_IS_NOT_FOUND` reason + `NOT_FOUND` error code.
 * Happy to be more specific if the SDK exposes a typed error class later.
 */
function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("FILES_API_DIRECTORY_IS_NOT_FOUND") ||
    msg.includes("directory being accessed is not found") ||
    /\bNOT_FOUND\b/.test(msg)
  );
}

function toSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "view"
  );
}

function decodeDataUrlOrBase64(input: string): Buffer | null {
  const stripped = input.startsWith("data:")
    ? input.substring(input.indexOf(",") + 1)
    : input;
  try {
    return Buffer.from(stripped, "base64");
  } catch {
    return null;
  }
}

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

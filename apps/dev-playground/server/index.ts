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
import { agents, createAgent, tool } from "@databricks/appkit/beta";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { z } from "zod";
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

// Code-defined demo agent showing the tools(plugins) function form
// alongside the markdown-driven agents in config/agents/.
const helper = createAgent({
  instructions:
    "You are a demo helper. Use analytics tools to answer data questions, " +
    "or get_weather for light small-talk.",
  tools(plugins) {
    return {
      ...plugins.analytics.toolkit(),
      get_weather: tool({
        name: "get_weather",
        description: "Get the current weather for a city",
        schema: z.object({ city: z.string().describe("City name") }),
        execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
      }),
    };
  },
});

/*
 * Smart-Dashboard agents.
 *
 * The three agents form a dispatcher pattern for the /smart-dashboard route.
 * The `query` agent (markdown, in config/agents/query/) routes user
 * questions to one of two specialists:
 *
 * - `sql_analyst` — writes Databricks SQL against `samples.nyctaxi.trips`
 *   using the analytics plugin's query tool.
 * - `dashboard_pilot` — emits UI-action tool calls (`apply_filter`,
 *   `highlight_period`) that the client reads off the SSE stream and
 *   translates into React state mutations. The server-side handlers are
 *   intentionally stubs — the tool-call JSON is the action payload.
 */

// Narrow, single-purpose tools.
//
// The earlier polymorphic `apply_filter({ field, operator, value })` was
// too expressive — the LLM could emit valid-looking calls the dispatcher
// couldn't faithfully apply (e.g. `field: "dropoff_zone"` when the
// dashboard only has a `pickup_zip` filter; `operator: "eq"` with a date).
// Splitting into one tool per filter verb removes the whole class of
// "agent said it worked but nothing moved" bugs.
//
// Each tool has exactly one client-side effect, rendered by
// use-action-dispatcher. Server handlers are still stubs — the tool-call
// JSON is the action payload.

const filter_by_date_range = tool({
  name: "filter_by_date_range",
  description:
    "Filter the dashboard to trips within a date range. Both start and end are required and must be ISO dates (YYYY-MM-DD) within 2016.",
  schema: z.object({
    start: z.string().describe("Start date in ISO format, e.g. 2016-03-01"),
    end: z.string().describe("End date in ISO format, e.g. 2016-03-31"),
  }),
  execute: async ({ start, end }) =>
    `Filtered dashboard to trips between ${start} and ${end}.`,
});

const filter_by_pickup_zip = tool({
  name: "filter_by_pickup_zip",
  description:
    "Filter the dashboard to trips originating from a specific pickup ZIP code. Use when the user asks about a specific pickup zone or ZIP.",
  schema: z.object({
    zip: z.string().describe("Pickup ZIP code, e.g. 10001"),
  }),
  execute: async ({ zip }) =>
    `Filtered dashboard to trips picked up in ${zip}.`,
});

const filter_by_fare = tool({
  name: "filter_by_fare",
  description:
    "Filter the dashboard to trips within a fare range. At least one of min or max must be provided.",
  schema: z
    .object({
      min: z.number().optional().describe("Minimum fare in USD"),
      max: z.number().optional().describe("Maximum fare in USD"),
    })
    .refine((v) => v.min !== undefined || v.max !== undefined, {
      message: "Provide at least one of min or max.",
    }),
  execute: async ({ min, max }) => {
    const parts = [] as string[];
    if (min !== undefined) parts.push(`>= $${min}`);
    if (max !== undefined) parts.push(`<= $${max}`);
    return `Filtered dashboard to trips with fare ${parts.join(" and ")}.`;
  },
});

const clear_filters = tool({
  name: "clear_filters",
  description:
    "Remove all active filters from the dashboard. Use when the user asks to reset, clear, or remove filters.",
  schema: z.object({}),
  execute: async () => "All filters cleared.",
});

const highlight_period = tool({
  name: "highlight_period",
  description:
    "Highlight a time period on the Trips Over Time chart to draw attention to a specific date range.",
  schema: z.object({
    start: z.string().describe("Start date in ISO format (YYYY-MM-DD)"),
    end: z.string().describe("End date in ISO format (YYYY-MM-DD)"),
    color: z
      .enum(["blue", "red", "yellow"])
      .optional()
      .describe("Highlight color. Defaults to blue."),
    label: z
      .string()
      .optional()
      .describe("Optional label for the highlighted period"),
  }),
  execute: async ({ start, end, color: _color, label }) => {
    const suffix = label ? ` (${label})` : "";
    return `Highlighted period ${start} to ${end}${suffix} on the dashboard.`;
  },
});

const clear_highlights = tool({
  name: "clear_highlights",
  description:
    "Remove all highlight overlays from the charts. Use when the user asks to clear, reset, or remove highlights.",
  schema: z.object({}),
  execute: async () => "All highlights cleared.",
});

// Restores a previously saved view. The tool-call arguments are the
// authoritative state: the client listens for this function_call on SSE
// and applies the filters + highlights directly without needing a round
// trip back for metadata. The agent is expected to have looked up the
// saved view server-side before emitting this call (it passes the
// already-resolved state through).
const load_view = tool({
  name: "load_view",
  description:
    "Restore a previously saved dashboard view by applying its filters and highlights. The caller supplies the already-resolved state so the client can apply it from this tool call without a second round trip.",
  schema: z.object({
    name: z.string().describe("The saved view's name (for UI feedback)"),
    filters: z
      .object({
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        pickup_zip: z.string().optional(),
        fare_min: z.string().optional(),
        fare_max: z.string().optional(),
      })
      .passthrough()
      .describe("Filters to restore. Omit fields that should not be set."),
    highlights: z
      .array(
        z.object({
          start: z.string(),
          end: z.string(),
          color: z.enum(["blue", "red", "yellow"]).optional(),
          label: z.string().optional(),
        }),
      )
      .describe("Highlight ranges to restore."),
  }),
  execute: async ({ name }) => `Restored saved view "${name}".`,
});

const focus_chart = tool({
  name: "focus_chart",
  description:
    "Scroll the user's viewport to a specific chart on the dashboard and briefly pulse it to draw attention. Use when the user asks to 'look at' or 'focus on' a specific visualization.",
  schema: z.object({
    chart_id: z
      .enum([
        "kpis",
        "trips_over_time",
        "fare_distribution",
        "hourly_heatmap",
        "top_zones",
      ])
      .describe("Which chart to focus on"),
  }),
  execute: async ({ chart_id }) => `Focused on ${chart_id}.`,
});

const highlight_zone = tool({
  name: "highlight_zone",
  description:
    "Draw an emphasis ring around a specific pickup ZIP on the Top Pickup Zones chart. Use this to call attention to a standout zone without filtering the whole dashboard to that ZIP.",
  schema: z.object({
    zip: z.string().describe("Pickup ZIP code to highlight (e.g. '10017')"),
    label: z
      .string()
      .optional()
      .describe("Optional short label shown inside the highlighted bar"),
  }),
  execute: async ({ zip, label }) =>
    `Highlighted pickup ZIP ${zip}${label ? ` (${label})` : ""}.`,
});

const clear_zone_highlights = tool({
  name: "clear_zone_highlights",
  description: "Remove all emphasis rings from the Top Pickup Zones chart.",
  schema: z.object({}),
  execute: async () => "Zone highlights cleared.",
});

// Write tool: exercises the approval gate. Server handler is a stub —
// no view persistence — but `effect: "write"` forces the human-in-the-loop
// flow before the agent can call it. We pick `write` (not `destructive`)
// because capturing a view CREATES a new file; nothing is deleted or
// overwritten. The approval card will render the low-severity blue
// "writes" treatment rather than the alarming red "destructive" one.
const save_view = tool({
  name: "save_view",
  description:
    "Persist the current dashboard configuration (filters + highlights) as a named view the user can recall later. Always surfaces the approval gate as a write action.",
  annotations: { effect: "write" },
  schema: z.object({
    name: z.string().describe("Short human-readable name for the saved view"),
    description: z
      .string()
      .optional()
      .describe("Optional longer description for the saved view"),
  }),
  execute: async ({ name, description }) => {
    const suffix = description ? `: ${description}` : "";
    return `Saved view "${name}"${suffix}.`;
  },
});

const sql_analyst = createAgent({
  instructions: [
    "You are a SQL expert for NYC taxi trip data (`samples.nyctaxi.trips`).",
    "Write Databricks SQL to answer the user's question and summarize the results clearly.",
    "IMPORTANT: The dataset only contains trips from 2016. Always add `WHERE tpep_pickup_datetime >= '2016-01-01' AND tpep_pickup_datetime < '2017-01-01'` unless the user specifies a narrower date range within 2016.",
    "If the user asks about dates outside 2016, say the dataset only covers 2016.",
    "Available columns: tpep_pickup_datetime, tpep_dropoff_datetime, trip_distance, fare_amount, pickup_zip, dropoff_zip.",
  ].join(" "),
  tools(plugins) {
    return { ...plugins.analytics.toolkit() };
  },
});

const dashboard_pilot = createAgent({
  instructions: [
    "You are the Smart Dashboard pilot. You do not query data — you manipulate the UI.",
    "Filters:",
    "- `filter_by_date_range({start, end})` — narrow to a date window within 2016.",
    "- `filter_by_pickup_zip({zip})` — narrow to trips from a specific ZIP.",
    "- `filter_by_fare({min?, max?})` — narrow by fare range (at least one bound required).",
    "- `clear_filters()` — remove all active filters.",
    "Highlights:",
    "- `highlight_period({start, end, color?, label?})` — shade a date window on the Trips Over Time chart.",
    "- `clear_highlights()` — remove all shaded overlays from the trips chart.",
    "- `highlight_zone({zip, label?})` — draw an emphasis ring around a specific ZIP on the Top Pickup Zones chart.",
    "- `clear_zone_highlights()` — remove all ZIP emphasis rings.",
    "Focus & save:",
    "- `focus_chart({chart_id})` — scroll the viewport to one of `kpis`, `trips_over_time`, `fare_distribution`, `hourly_heatmap`, `top_zones` and briefly pulse it.",
    "- `save_view({name, description?})` — persist the current configuration. Write action; the user will see an approval card.",
    "- `load_view({name, filters, highlights})` — restore a previously saved view. Always pass the resolved state; never leave fields unset.",
    "Rules:",
    "1. Pick the single tool that matches the user's intent. Do not chain filters unless the user asks for a compound filter.",
    "2. Briefly state what you did after the tool returns. Do not narrate before calling the tool.",
    "3. If the user's request is ambiguous (e.g. 'filter to last month' without a 2016 context), ask one clarifying question before calling any tool.",
    "4. For standout ZIPs, prefer `highlight_zone` over `filter_by_pickup_zip` so the rest of the dashboard stays in context. Only filter when the user explicitly asks to narrow the whole dashboard.",
  ].join("\n"),
  tools: {
    filter_by_date_range,
    filter_by_pickup_zip,
    filter_by_fare,
    clear_filters,
    highlight_period,
    clear_highlights,
    highlight_zone,
    clear_zone_highlights,
    focus_chart,
    save_view,
    load_view,
  },
});

createApp({
  plugins: [
    server(),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    genie({
      spaces: { demo: process.env.DATABRICKS_GENIE_SPACE_ID ?? "placeholder" },
    }),
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
      },
    }),
    serving(),
    agents({
      agents: { helper, sql_analyst, dashboard_pilot },
      // `query` (markdown dispatcher) + `sql_analyst` + `dashboard_pilot`
      // wire the /smart-dashboard route. `insights` and `anomaly` are
      // ephemeral markdown agents auto-fired by the route's AgentSidebar.
      // `helper` is the conversational default for the bare `/agent` route
      // (the markdown agents are dispatchers or ephemeral and don't make
      // sense as the user-facing landing agent).
      defaultAgent: "helper",
    }),
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
  async onPluginsReady(appkit) {
    appkit.server.extend((app) => {
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

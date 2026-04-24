import "reflect-metadata";
import {
  agents,
  analytics,
  createAgent,
  createApp,
  type FilePolicy,
  files,
  fromPlugin,
  genie,
  jobs,
  PolicyDeniedError,
  server,
  serving,
  tool,
  WRITE_ACTIONS,
} from "@databricks/appkit";
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

// Code-defined demo agent showing the fromPlugin() API alongside the
// markdown-driven agents in config/agents/.
const helper = createAgent({
  instructions:
    "You are a demo helper. Use analytics tools to answer data questions, " +
    "or get_weather for light small-talk.",
  tools: {
    ...fromPlugin(analytics),
    get_weather: tool({
      name: "get_weather",
      description: "Get the current weather for a city",
      schema: z.object({ city: z.string().describe("City name") }),
      execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
    }),
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

const apply_filter = tool({
  name: "apply_filter",
  description:
    "Apply a filter to the dashboard data. This updates the KPIs and charts to reflect only the filtered data.",
  schema: z.object({
    field: z
      .enum(["date", "pickup_zone", "dropoff_zone", "fare_range"])
      .describe("The field to filter on"),
    operator: z
      .enum(["eq", "gt", "lt", "between", "in"])
      .describe("The comparison operator"),
    value: z
      .union([z.string(), z.array(z.string())])
      .describe(
        "Filter value. For 'between', use an array of two values [start, end]. For 'in', use an array of values.",
      ),
  }),
  execute: async ({ field, operator, value }) => {
    const valueStr = Array.isArray(value) ? value.join(" to ") : value;
    return `Filter applied: ${field} ${operator} ${valueStr}. The dashboard will update to reflect this filter.`;
  },
});

const highlight_period = tool({
  name: "highlight_period",
  description:
    "Highlight a time period on the dashboard charts to draw attention to a specific date range.",
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
    return `Highlighted period ${start} to ${end}${suffix} on the dashboard charts.`;
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
  tools: {
    ...fromPlugin(analytics),
  },
});

const dashboard_pilot = createAgent({
  instructions: [
    "You are the Smart Dashboard pilot. You do not query data — you manipulate the UI.",
    "Use `apply_filter` to filter the dashboard by date range, zone, or fare range.",
    "Use `highlight_period` to highlight a time range on the charts.",
    "When the user asks to 'show me', 'filter to', or 'highlight' something, pick the matching tool and call it.",
    "Always briefly state what you did after applying an action.",
  ].join(" "),
  tools: {
    apply_filter,
    highlight_period,
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
    jobs(),
    serving(),
    agents({
      agents: { helper, sql_analyst, dashboard_pilot },
      // `query` (markdown dispatcher) + `sql_analyst` + `dashboard_pilot`
      // wire the /smart-dashboard route. `insights` and `anomaly` are
      // ephemeral markdown agents auto-fired by the route's AgentSidebar.
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
  onPluginsReady(appkit) {
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
    });
  },
}).catch(console.error);

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

#!/usr/bin/env tsx
/**
 * Soak test for @databricks/lakebase connection lifetime vs OAuth token expiry.
 *
 * Runs a real pool against a real Lakebase Autoscaling endpoint for longer than
 * one token lifetime (default 75 minutes) and checks that connections are
 * recycled before the token they logged in with expires. Use your own sandbox
 * project; never point this at a shared database.
 *
 * It imports the package from source, so it tests whatever is checked out:
 * run it on `main` for the "before" numbers and on the fix branch for "after".
 *
 * What it does
 * - Opens query "slots" on a ramp (one more every --ramp-minutes) so new
 *   connections are created throughout the run, including late in a token's
 *   life. Each tick, every active slot runs a short query in parallel, which
 *   keeps them on separate connections.
 * - Disables the pool's idle timeout. The package default (30 s) equals the
 *   30 s query interval, so idle connections would close between ticks, every
 *   query would get a fresh connection, and the run would pass on buggy code.
 * - Holds one extra connection checked out for the whole run (unless
 *   --skip-held). pg-pool only recycles a connection once it is released, so
 *   this one deliberately outlives its token; it's reported separately.
 * - Wraps the pool's password callback to count connections and token mints
 *   and to read each token's remaining life from its JWT `exp` claim. Tokens
 *   are never written anywhere; they are identified by mint number only.
 *
 * Pass criteria: no stalls (a gap between successful queries longer than
 * three intervals, as when the machine sleeps or loses its network, makes the
 * run invalid), no auth or query errors, every pool connection younger than
 * the lifetime, every connection recycled before its token is 4 hours old
 * (when Unity Catalog claims lapse; oldest token age at login + lifetime under
 * 3.5 hours), the custom application_name on every connection, and a run that
 * crosses the one-hour token boundary. With --probe-table, every read on a
 * pool connection must also succeed; the held connection's reads are reported
 * separately and don't count, since it's expected to lose Unity Catalog access
 * 4 hours after its token was minted. Mints per pool-hour is reported so the
 * load on the credential service can be reviewed. Telemetry span completion is not
 * checked here.
 *
 * Usage
 *   export DATABRICKS_CONFIG_PROFILE=<your-profile>   # Databricks auth
 *   export PGHOST=<endpoint-host> PGDATABASE=databricks_postgres
 *   export LAKEBASE_ENDPOINT=projects/<p>/branches/<b>/endpoints/<e>
 *   export PGUSER=<your-user-or-service-principal-id>
 *   pnpm exec tsx tools/lakebase-soak.ts [--minutes 75] [--lifetime-seconds 1800]
 *
 * To see whether access granted through Unity Catalog lapses when the token
 * expires (as opposed to native Postgres GRANTs, which don't), run as a service
 * principal whose only access to a table is UC-derived, such as a synced table
 * it created, and pass --probe-table <schema.table>. Authenticate the service
 * principal with DATABRICKS_HOST, DATABRICKS_CLIENT_ID and
 * DATABRICKS_CLIENT_SECRET (and unset DATABRICKS_CONFIG_PROFILE); set PGUSER
 * to its application ID.
 *
 * UC-only access works only with a token that requests claims, which
 * createLakebasePool can't do. Add --claims-table <catalog.schema.table> to
 * mint each token with READ_ONLY claims for that UC table instead (keeping the
 * package's current cache rule); pair it with --probe-table for the same
 * table's Postgres name, e.g.
 *   --claims-table main.app.items --probe-table app.items
 * Add --ttl-seconds 300 to mint 5-minute claims tokens, so a short run can
 * show whether access on open connections lapses at, or some multiple of,
 * the token's own expiry.
 *
 * On macOS the harness runs `caffeinate -ims` for its own lifetime, which
 * keeps the machine awake while it's on AC power. Closing the lid still
 * sleeps a laptop with no external display, so keep it open, plugged in and
 * on a network the workspace's IP access list allows (for example the VPN).
 *
 * Omit --lifetime-seconds to test the package default. Results go to
 * --out (default tmp/lakebase-soak/<timestamp>/, which is gitignored): events.jsonl and summary.json.
 * Exit code is 0 when every check passes, 1 otherwise. Ctrl-C stops early and
 * still writes a summary, marked incomplete.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import {
  createLakebasePool,
  generateDatabaseCredential,
  getWorkspaceClient,
  RequestedClaimsPermissionSet,
} from "../packages/lakebase/src/index";

type Pool = ReturnType<typeof createLakebasePool>;

const { values: args } = parseArgs({
  options: {
    minutes: { type: "string", default: "75" },
    "interval-seconds": { type: "string", default: "30" },
    "lifetime-seconds": { type: "string" },
    slots: { type: "string", default: "8" },
    "ramp-minutes": { type: "string", default: "7" },
    "query-seconds": { type: "string", default: "1" },
    "app-name": { type: "string", default: "appkit-lakebase-soak" },
    "skip-held": { type: "boolean", default: false },
    "probe-table": { type: "string" },
    "claims-table": { type: "string" },
    "ttl-seconds": { type: "string" },
    out: { type: "string" },
  },
});

// Optional table to read on every probe, as schema.table. Use one the identity
// can reach only through Unity Catalog (for example a synced table it created)
// to see whether that access lapses when the token expires.
const PROBE_TABLE = args["probe-table"]
  ?.split(".")
  .map((part) => `"${part.replaceAll('"', '""')}"`)
  .join(".");

const MINUTES = Number(args.minutes);
const INTERVAL_MS = Number(args["interval-seconds"]) * 1000;
const SLOTS = Number(args.slots);
const RAMP_MS = Number(args["ramp-minutes"]) * 60_000;
const QUERY_SECONDS = Number(args["query-seconds"]);
const APP_NAME = args["app-name"];
const REQUESTED_LIFETIME_S =
  args["lifetime-seconds"] === undefined
    ? undefined
    : Number(args["lifetime-seconds"]);
// Shorter-lived claims tokens (300-3600 s) let a short run probe what happens
// after expiry. Only used with --claims-table.
const TTL_SECONDS =
  args["ttl-seconds"] === undefined ? undefined : Number(args["ttl-seconds"]);
if (TTL_SECONDS !== undefined) {
  if (!args["claims-table"]) {
    throw new Error("--ttl-seconds only applies with --claims-table");
  }
  if (!(TTL_SECONDS >= 300 && TTL_SECONDS <= 3600)) {
    throw new Error("--ttl-seconds must be between 300 and 3600");
  }
}
// The token lifetime the run measures against: the requested TTL, or Lakebase's
// default of one hour.
const TOKEN_BOUNDARY_MINUTES = (TTL_SECONDS ?? 3600) / 60;
// A connection whose lifetime timer fires mid-query is closed when the query
// finishes, so allow the query duration plus a little scheduling slack.
const AGE_SLACK_S = QUERY_SECONDS + 5;
// Longer than this without a successful query means the run stalled (the
// machine slept, or lost the network), so its results don't cover that time.
const MAX_GAP_S = Math.max(3 * (INTERVAL_MS / 1000), 90);

const OUT_DIR =
  args.out ??
  join("tmp", "lakebase-soak", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(OUT_DIR, { recursive: true });
const EVENTS_FILE = join(OUT_DIR, "events.jsonl");

const startedAt = Date.now();

// Keep macOS awake for as long as this process runs (AC power only; a closed
// lid still sleeps). caffeinate exits by itself when this process does.
if (process.platform === "darwin") {
  spawn("caffeinate", ["-ims", "-w", String(process.pid)], {
    stdio: "ignore",
    detached: true,
  })
    .on("error", () =>
      console.warn("caffeinate not available; the machine may sleep"),
    )
    .unref();
}

const elapsedS = () => Math.round((Date.now() - startedAt) / 1000);

function record(event: Record<string, unknown>) {
  appendFileSync(
    EVENTS_FILE,
    `${JSON.stringify({ t: new Date().toISOString(), elapsed_s: elapsedS(), ...event })}\n`,
  );
}

/**
 * Seconds until the token's JWT `exp` and since its `iat`, or undefined if it
 * isn't a JWT. Without `iat`, the age is worked out from the token lifetime.
 */
function tokenTimes(
  token: string,
): { remainingS: number; ageS: number } | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown; iat?: unknown };
    if (typeof payload.exp !== "number") return undefined;
    const nowS = Date.now() / 1000;
    const remainingS = Math.round(payload.exp - nowS);
    const ageS =
      typeof payload.iat === "number"
        ? Math.round(nowS - payload.iat)
        : TOKEN_BOUNDARY_MINUTES * 60 - remainingS;
    return { remainingS, ageS };
  } catch {
    return undefined;
  }
}

// Access granted through Unity Catalog claims stops working 4 hours after a
// token was minted, while the connection stays up (measured on a live
// endpoint). A connection is safe if it's recycled before then, with the same
// margin the unit tests use for checkout overrun, login time and clock skew.
const CLAIMS_LAPSE_S = 4 * 60 * 60;
const SAFETY_MARGIN_S = 30 * 60;

function isAuthError(error: unknown): boolean {
  const { code, message } = (error ?? {}) as {
    code?: string;
    message?: string;
  };
  return (
    code === "28P01" ||
    code === "28000" ||
    /password|authenticat|token|expired|permission/i.test(message ?? "")
  );
}

// ── Pool under test ──────────────────────────────────────────────────

const pool: Pool = createLakebasePool({
  application_name: APP_NAME,
  ...(REQUESTED_LIFETIME_S === undefined
    ? {}
    : { maxLifetimeSeconds: REQUESTED_LIFETIME_S }),
  idleTimeoutMillis: 0,
  max: SLOTS + 1,
  logger: {
    debug: () => {},
    info: () => {},
    warn: (message, ...rest) =>
      record({ type: "package_warning", message, detail: String(rest) }),
    error: (message, ...rest) =>
      record({ type: "package_error", message, detail: String(rest) }),
  },
});
// What actually reached pg.Pool. 0 means pg never recycles connections.
const effectiveLifetimeS = Number(pool.options.maxLifetimeSeconds ?? 0);

let connects = 0;
let mints = 0;
let lastToken: string | undefined;
const connectTokenRemaining: number[] = [];
const connectTokenAge: number[] = [];
const packagePassword = pool.options.password;
if (typeof packagePassword !== "function") {
  throw new Error(
    "Expected an OAuth password callback; set LAKEBASE_ENDPOINT and don't set a static password.",
  );
}

/**
 * Tokens minted with Unity Catalog claims for one table. createLakebasePool
 * can't request claims, and access that comes only through UC needs them, so
 * this stands in for the package's callback when --claims-table is set. It
 * copies the package's current cache rule (reuse until 2 minutes before
 * expiry, one mint in flight at a time) so the run shows how today's pool
 * would behave if it requested claims.
 */
function createClaimsPassword(
  table: string,
  ttlSeconds?: number,
): () => Promise<string> {
  const endpoint = process.env.LAKEBASE_ENDPOINT;
  if (!endpoint) throw new Error("--claims-table needs LAKEBASE_ENDPOINT");
  const workspaceClient = getWorkspaceClient({});
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;
  return async () => {
    if (cached && Date.now() < cached.expiresAt - 2 * 60_000) {
      return cached.token;
    }
    inFlight ??= generateDatabaseCredential(workspaceClient, {
      endpoint,
      claims: [
        {
          permission_set: RequestedClaimsPermissionSet.READ_ONLY,
          resources: [{ table_name: table }],
        },
      ],
      // The credential API accepts a ttl of 300-3600 s; the package's request
      // type doesn't model it, so it's added here for --ttl-seconds.
      ...(ttlSeconds === undefined ? {} : { ttl: `${ttlSeconds}s` }),
    } as Parameters<typeof generateDatabaseCredential>[1])
      .then((credential) => {
        cached = {
          token: credential.token,
          expiresAt: new Date(credential.expire_time).getTime(),
        };
        return credential.token;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

const originalPassword = args["claims-table"]
  ? createClaimsPassword(args["claims-table"], TTL_SECONDS)
  : (packagePassword as () => Promise<string>);
pool.options.password = async () => {
  const token = await originalPassword();
  connects++;
  const newToken = token !== lastToken;
  if (newToken) {
    mints++;
    lastToken = token;
  }
  const times = tokenTimes(token);
  if (times) {
    connectTokenRemaining.push(times.remainingS);
    connectTokenAge.push(times.ageS);
  }
  record({
    type: "connect",
    connect: connects,
    token_mint: mints,
    new_token: newToken,
    token_remaining_s: times?.remainingS,
    token_age_s: times?.ageS,
  });
  return token;
};
pool.on("error", (error) =>
  record({
    type: "pool_error",
    code: (error as { code?: string }).code,
    message: error.message,
  }),
);

// ── Load ─────────────────────────────────────────────────────────────

// A session can always see its own row in pg_stat_activity.
const PROBE_SQL = `SELECT a.pid,
  extract(epoch FROM now() - a.backend_start)::float8 AS age_s,
  a.application_name AS app,
  pg_sleep($1::float8)::text AS slept
FROM pg_stat_activity a
WHERE a.pid = pg_backend_pid()`;

type Probe = { pid: number; age_s: number; app: string };
type Runner = { query: Pool["query"] };
type Client = Runner & {
  release(error?: Error | boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
};

// pg-pool only handles errors on idle clients. A checked-out client whose
// connection the server drops (restart, failover, scale-to-zero, the 24-hour
// limit) emits "error", and with no listener that crashes the process. Apps
// holding a client must listen; so does the harness, to keep running and
// count these.
const clientErrors = { count: 0, first: "" };
function clientErrorListener(label: string) {
  return (error: Error) => {
    const { code } = error as Error & { code?: string };
    clientErrors.count++;
    clientErrors.first ||= `${code ?? "no code"}: ${error.message}`;
    record({ type: "client_error", slot: label, code, message: error.message });
  };
}

const maxAgeByPid = new Map<number, number>();
const appNames = new Set<string>();
let queriesOk = 0;
let queriesFailed = 0;
let authErrors = 0;
let lastSuccessAt = startedAt;
let longestGapS = 0;
const stalls = {
  count: 0,
  totalS: 0,
  firstAtS: undefined as number | undefined,
};
let maxPoolSize = 0;
const held = { maxAgeS: 0, errors: 0, errorsAfterBoundary: 0, firstError: "" };

// Pool connections and the held connection are counted separately: the held
// one is never recycled, so it's expected to lose claims access at 4 hours,
// and only the pool connections decide whether the fix works.
function newTableCounts() {
  return {
    ok: 0,
    denied: 0,
    deniedAfterBoundary: 0,
    otherErrors: 0,
    firstDeniedAtS: undefined as number | undefined,
    lastOkAt: startedAt,
    deniedConnectionAgesS: [] as number[],
    firstError: "",
  };
}
const tableProbe = { pool: newTableCounts(), held: newTableCounts() };

function tableCountsSummary(counts: ReturnType<typeof newTableCounts>) {
  return {
    ok: counts.ok,
    permission_denied: counts.denied,
    permission_denied_after_token_boundary: counts.deniedAfterBoundary,
    other_errors: counts.otherErrors,
    first_denied_at_s: counts.firstDeniedAtS ?? null,
    youngest_denied_connection_age_s: counts.deniedConnectionAgesS.length
      ? Math.min(...counts.deniedConnectionAgesS)
      : null,
    first_error: counts.firstError || null,
  };
}

// Runs on the same connection as the age probe, so a permission error can be
// tied to how old that connection (and the token it logged in with) was.
async function probeTable(client: Client, label: string, row: Probe) {
  if (!PROBE_TABLE) return;
  const counts = label === "held" ? tableProbe.held : tableProbe.pool;
  try {
    await client.query(`SELECT count(*) FROM ${PROBE_TABLE}`);
    counts.ok++;
    counts.lastOkAt = Date.now();
    record({
      type: "table_query",
      slot: label,
      pid: row.pid,
      age_s: Math.round(row.age_s),
    });
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    if (code === "42501") {
      counts.denied++;
      counts.firstDeniedAtS ??= elapsedS();
      if (elapsedS() > TOKEN_BOUNDARY_MINUTES * 60) {
        counts.deniedAfterBoundary++;
      }
      counts.deniedConnectionAgesS.push(Math.round(row.age_s));
    } else {
      counts.otherErrors++;
    }
    counts.firstError ||= message ?? String(error);
    record({
      type: "table_error",
      slot: label,
      pid: row.pid,
      age_s: Math.round(row.age_s),
      code,
      message,
    });
  }
}

// Pool slots check a connection out for the probe and return it afterwards;
// the held connection is passed in and never returned.
async function probe(label: string, heldConnection?: Client) {
  let client = heldConnection;
  let broken: Error | undefined;
  const onError = clientErrorListener(label);
  try {
    if (!client) {
      client = (await pool.connect()) as Client;
      client.on("error", onError);
    }
    const { rows } = await client.query(PROBE_SQL, [QUERY_SECONDS]);
    const row = rows[0] as Probe;
    appNames.add(row.app);
    if (label === "held") {
      held.maxAgeS = Math.max(held.maxAgeS, row.age_s);
    } else {
      maxAgeByPid.set(
        row.pid,
        Math.max(maxAgeByPid.get(row.pid) ?? 0, row.age_s),
      );
    }
    queriesOk++;
    noteGap(Date.now());
    lastSuccessAt = Date.now();
    record({
      type: "query",
      slot: label,
      pid: row.pid,
      age_s: Math.round(row.age_s),
      app: row.app,
    });
    await probeTable(client, label, row);
  } catch (error) {
    broken = error as Error;
    const { code, message } = error as { code?: string; message?: string };
    const auth = isAuthError(error);
    if (label === "held") {
      held.errors++;
      if (elapsedS() > TOKEN_BOUNDARY_MINUTES * 60) held.errorsAfterBoundary++;
      held.firstError ||= message ?? String(error);
    } else {
      queriesFailed++;
      if (auth) authErrors++;
    }
    record({ type: "query_error", slot: label, code, auth, message });
  } finally {
    // Like pool.query: a connection that errored is discarded, not reused.
    if (!heldConnection) {
      client?.off("error", onError);
      client?.release(broken);
    }
  }
}

// Called with the time of each success, and once at the end so a run that
// stops succeeding partway through still counts the trailing gap.
function noteGap(now: number) {
  const gapS = (now - lastSuccessAt) / 1000;
  longestGapS = Math.max(longestGapS, gapS);
  if (gapS > MAX_GAP_S) {
    stalls.count++;
    stalls.totalS += gapS;
    stalls.firstAtS ??= Math.round((lastSuccessAt - startedAt) / 1000);
    record({
      type: "stall",
      from_s: Math.round((lastSuccessAt - startedAt) / 1000),
      gap_s: Math.round(gapS),
    });
  }
}

let stopRequested = false;
process.on("SIGINT", () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.log("\nStopping after this tick (Ctrl-C again to quit immediately)…");
});

record({
  type: "start",
  minutes: MINUTES,
  interval_s: INTERVAL_MS / 1000,
  requested_lifetime_s: REQUESTED_LIFETIME_S ?? "package default",
  effective_lifetime_s: effectiveLifetimeS,
  slots: SLOTS,
  ramp_minutes: RAMP_MS / 60_000,
  held_connection: !args["skip-held"],
  token_source: args["claims-table"]
    ? `claims for ${args["claims-table"]}`
    : "package",
});
console.log(
  `Soak: ${MINUTES} min, lifetime reaching pg.Pool = ${effectiveLifetimeS}s` +
    `${effectiveLifetimeS === 0 ? " (never recycled)" : ""}, ${SLOTS} slots, results in ${OUT_DIR}`,
);

// Fail fast with a readable message if the first connection can't be made
// (wrong PGHOST, expired Databricks login, missing permissions, …).
let heldClient: Client | undefined;
try {
  await pool.query("SELECT 1");
  heldClient = args["skip-held"]
    ? undefined
    : ((await pool.connect()) as Client);
  heldClient?.on("error", clientErrorListener("held"));
} catch (error) {
  const { code, message } = error as { code?: string; message?: string };
  record({ type: "startup_error", code, message });
  console.error(
    `Could not connect to Lakebase: ${message ?? String(error)}${code ? ` (${code})` : ""}`,
  );
  await pool.end().catch(() => {});
  process.exit(1);
}
const endAt = startedAt + MINUTES * 60_000;
for (let tick = 0; Date.now() < endAt && !stopRequested; tick++) {
  const activeSlots = Math.min(
    SLOTS,
    1 + Math.floor((Date.now() - startedAt) / RAMP_MS),
  );
  await Promise.all([
    ...Array.from({ length: activeSlots }, (_, i) => probe(`slot-${i}`)),
    ...(heldClient ? [probe("held", heldClient)] : []),
  ]);
  maxPoolSize = Math.max(maxPoolSize, pool.totalCount);
  record({
    type: "pool",
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
  console.log(
    `[${String(Math.floor(elapsedS() / 60)).padStart(3)} min] slots=${activeSlots} ` +
      `connections=${pool.totalCount} connects=${connects} mints=${mints} ` +
      `ok=${queriesOk} failed=${queriesFailed} auth_errors=${authErrors}`,
  );
  const nextTickAt = startedAt + (tick + 1) * INTERVAL_MS;
  if (Date.now() - lastSuccessAt > MAX_GAP_S * 1000) {
    console.warn(
      `  no successful query for ${Math.round((Date.now() - lastSuccessAt) / 1000)} s; this stretch of the run is invalid`,
    );
  }
  await sleep(Math.max(0, nextTickAt - Date.now()));
}

heldClient?.release();
const waitingAtEnd = pool.waitingCount;
await pool.end();

// ── Summary ──────────────────────────────────────────────────────────

const endedAt = Date.now();
noteGap(endedAt);
const durationH = (endedAt - startedAt) / 3_600_000;
const ages = [...maxAgeByPid.values()].sort((a, b) => a - b);
const pct = (p: number) =>
  ages.length
    ? Math.round(ages[Math.min(ages.length - 1, Math.floor(p * ages.length))])
    : null;
const maxAge = ages.at(-1) ?? 0;
const minTokenAtConnect = connectTokenRemaining.length
  ? Math.min(...connectTokenRemaining)
  : undefined;
const maxTokenAgeAtConnect = connectTokenAge.length
  ? Math.max(...connectTokenAge)
  : undefined;

const checks = {
  // A sleeping or disconnected machine makes no queries, so it can't see
  // errors either; without this, a stalled run could still pass.
  no_stalls: stalls.count === 0,
  run_crossed_token_boundary: durationH * 60 > TOKEN_BOUNDARY_MINUTES,
  no_auth_errors: authErrors === 0,
  no_query_errors: queriesFailed === 0,
  connections_recycled:
    effectiveLifetimeS > 0 && maxAge <= effectiveLifetimeS + AGE_SLACK_S,
  // The oldest token any connection logged in with, plus the lifetime, must
  // stay clear of the 4-hour claims lapse. The held connection is excluded by
  // design: it's never recycled, to show what a long-held client does.
  connections_close_before_claims_lapse:
    effectiveLifetimeS > 0 &&
    maxTokenAgeAtConnect !== undefined &&
    maxTokenAgeAtConnect + effectiveLifetimeS <
      CLAIMS_LAPSE_S - SAFETY_MARGIN_S,
  application_name_on_every_connection:
    appNames.size === 1 && appNames.has(APP_NAME),
  no_clients_waiting_at_end: waitingAtEnd === 0,
  ...(PROBE_TABLE
    ? {
        probe_table_readable_throughout:
          tableProbe.pool.ok > 0 &&
          (endedAt - tableProbe.pool.lastOkAt) / 1000 <= MAX_GAP_S &&
          tableProbe.pool.denied === 0 &&
          tableProbe.pool.otherErrors === 0,
      }
    : {}),
};
const passed = Object.values(checks).every(Boolean);

const summary = {
  passed,
  incomplete: stopRequested,
  checks,
  duration_minutes: Math.round(durationH * 60),
  token_source: args["claims-table"]
    ? `UC claims for ${args["claims-table"]} (harness-minted, package cache rule, ttl ${TTL_SECONDS ?? 3600}s)`
    : "package (createLakebasePool, no claims)",
  lifetime: {
    requested_s: REQUESTED_LIFETIME_S ?? "package default",
    effective_s: effectiveLifetimeS,
  },
  mints: {
    total: mints,
    per_pool_hour: Number((mints / durationH).toFixed(2)),
    // Excludes the first mint at startup, which every pool pays once; this is
    // the steady-state refresh rate (about 1 per hour with today's cache).
    refreshes_per_pool_hour: Number(
      (Math.max(0, mints - 1) / durationH).toFixed(2),
    ),
    note: "Token mints per pool-hour, for reviewing load on the credential service.",
  },
  connections_opened: connects,
  token_at_connect_s: {
    min_remaining: minTokenAtConnect ?? "unknown (token is not a JWT)",
    max_age: maxTokenAgeAtConnect ?? "unknown (token is not a JWT)",
    readings: connectTokenAge.length,
    safe_limit_for_age_plus_lifetime: CLAIMS_LAPSE_S - SAFETY_MARGIN_S,
  },
  pool_connection_age_s: {
    connections: ages.length,
    min: pct(0),
    median: pct(0.5),
    p95: pct(0.95),
    max: ages.length ? Math.round(maxAge) : null,
  },
  queries: {
    ok: queriesOk,
    failed: queriesFailed,
    auth_errors: authErrors,
    success_rate: Number(
      (queriesOk / Math.max(1, queriesOk + queriesFailed)).toFixed(4),
    ),
    longest_gap_between_successes_s: Math.round(longestGapS),
  },
  stalls: {
    note: `Gaps of more than ${MAX_GAP_S} s with no successful query (sleep, network loss); the run doesn't cover them.`,
    count: stalls.count,
    total_s: Math.round(stalls.totalS),
    first_at_s: stalls.firstAtS ?? null,
  },
  max_pool_size: maxPoolSize,
  application_names_seen: [...appNames],
  held_connection: args["skip-held"]
    ? "skipped"
    : {
        note: "Checked out for the whole run, so never recycled; shows what a long-held connection does after its token expires.",
        max_age_s: Math.round(held.maxAgeS),
        errors: held.errors,
        errors_after_token_boundary: held.errorsAfterBoundary,
        first_error: held.firstError || null,
      },
  client_errors: {
    note: "Errors emitted by checked-out clients (server dropped the connection). Without a listener these crash a Node app.",
    count: clientErrors.count,
    first: clientErrors.first || null,
  },
  probe_table: PROBE_TABLE
    ? {
        table: args["probe-table"],
        note: "permission_denied counts SQLSTATE 42501 (UC-derived access lapsing). Only pool connections decide probe_table_readable_throughout; the held connection is never recycled, so it's expected to lose access 4 hours after its token was minted.",
        pool_connections: tableCountsSummary(tableProbe.pool),
        held_connection: args["skip-held"]
          ? "skipped"
          : tableCountsSummary(tableProbe.held),
      }
    : "not set",
};

writeFileSync(
  join(OUT_DIR, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
console.log(`\n${passed ? "PASS" : "FAIL"}: details in ${OUT_DIR}`);
process.exit(passed ? 0 : 1);

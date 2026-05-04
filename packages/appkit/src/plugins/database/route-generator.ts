import type express from "express";
import type { IAppRouter, RouteConfig } from "shared";
import { ZodError } from "zod";
import type { AppKitTable, Schema } from "@/database";
import { AppKitError } from "@/errors";
import { createLogger } from "@/logging/logger";
import { DatabaseRouteError } from "./database";
import type { EntityClient, WhereInput } from "./entity-proxy";
import type { HttpAccess, HttpEntityOverride, IDatabaseConfig } from "./types";

type ColumnKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "uuid"
  | "unknown";

/**
 * Read the Drizzle `columnType` off a table's `$drizzle` value to classify a
 * column as text/number/boolean/etc. Used to keep `coerceFilterValue` and
 * `coerceId` from over-eagerly coercing strings on text/uuid columns.
 *
 * Hand-rolled (rather than importing Drizzle's types) so this file stays out
 * of the drizzle-orm import graph — `$drizzle` is `unknown` at the AppKit
 * boundary, but the runtime layer already reads the same property names off
 * it (see `database/runtime/drizzle-runtime.ts:getColumn`).
 */
function inferColumnKind(table: AppKitTable, name: string): ColumnKind {
  const drizzleTable = table.$drizzle as
    | Record<string, { columnType?: string } | undefined>
    | undefined;
  const ct = drizzleTable?.[name]?.columnType ?? "";
  if (ct === "PgText" || ct === "PgVarchar") return "text";
  if (
    ct === "PgInteger" ||
    ct === "PgSerial" ||
    ct === "PgBigInt" ||
    ct === "PgBigInt53"
  ) {
    return "number";
  }
  if (ct === "PgBoolean") return "boolean";
  if (ct === "PgTimestamp") return "date";
  if (ct === "PgJsonb" || ct === "PgJson") return "json";
  if (ct === "PgUuid") return "uuid";
  return "unknown";
}

function buildColumnKindMap(
  table: AppKitTable,
  cols: ReadonlySet<string>,
): Map<string, ColumnKind> {
  const out = new Map<string, ColumnKind>();
  for (const name of cols) out.set(name, inferColumnKind(table, name));
  return out;
}

const logger = createLogger("database:routes");

type Verb = "list" | "find" | "count" | "create" | "update" | "delete";
type DatabaseExecutionSurface = Record<string, EntityClient>;

// Zero-trust default: every generated route runs OBO unless the app author
// explicitly opts that verb into service/public mode or disables it.
const DEFAULT_ACCESS: Record<Verb, HttpAccess> = {
  list: "obo",
  find: "obo",
  count: "obo",
  create: "obo",
  update: "obo",
  delete: "obo",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// These query params control the shape of the read. Everything else is treated
// as a potential column filter, but only if it matches a declared schema column.
const RESERVED_QUERY_KEYS = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "include",
  "on_conflict",
]);

// Keep the HTTP dialect intentionally identical to PostGREST's builder methods:
// `?age=gte.18`, `?name=ilike.%foo%`, `?id=in.(1,2,3)`.
const ALLOWED_OPS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "in",
  "is",
]);

interface RouteGeneratorOptions {
  schema: Schema;
  config: IDatabaseConfig;
  /**
   * DatabasePlugin owns identity selection. The route generator only says which
   * access mode was configured for the verb and receives the right entity map.
   */
  getSurface: (
    req: express.Request,
    access: HttpAccess,
  ) => DatabaseExecutionSurface;
  /**
   * Service-principal pool used for the `_healthz` `SELECT 1` probe. Optional
   * because some tests exercise the route generator without a real pool.
   */
  getServicePool?: () => import("pg").Pool;
  /** Bound wrapper around Plugin#route so endpoint registration stays central. */
  route: (router: IAppRouter, config: RouteConfig) => void;
}

/**
 * Generates the HTTP layer for every schema table.
 *
 * This class deliberately does not know about PostGREST clients, pg pools, or
 * auth internals. It translates Express requests into the L3 EntityClient API;
 * the entity client then handles validation, hooks, execute wrapping, retries,
 * cache, telemetry, and DataPath calls.
 */
export class RouteGenerator {
  constructor(private readonly options: RouteGeneratorOptions) {}

  injectAll(router: IAppRouter): void {
    this.bindHealth(router);
    for (const [name, table] of Object.entries(this.options.schema.$tables)) {
      this.injectEntity(router, name, table);
    }
  }

  /**
   * Mount `GET /api/database/_healthz`. Runs a `SELECT 1` against the SP
   * pool and returns `{ ok, poolStats }` so a load balancer can wait for the
   * database side of the plugin to come up before routing traffic.
   *
   * The route is always public — readiness checks come from k8s/LB
   * components that don't carry user auth headers.
   */
  private bindHealth(router: IAppRouter): void {
    if (this.options.config.healthCheck === false) return;
    const getPool = this.options.getServicePool;
    if (!getPool) return;
    this.options.route(router, {
      name: "database._healthz",
      method: "get",
      path: "/_healthz",
      handler: async (_req, res) => {
        try {
          const pool = getPool();
          await pool.query("SELECT 1");
          res.json({
            ok: true,
            poolStats: {
              total: pool.totalCount,
              idle: pool.idleCount,
              waiting: pool.waitingCount,
            },
          });
        } catch (error) {
          logger.warn("database health check failed: %O", error);
          res.status(503).json({ ok: false });
        }
      },
    });
  }

  private injectEntity(
    router: IAppRouter,
    name: string,
    table: AppKitTable,
  ): void {
    const access = resolveAccess(this.options.config.http?.[name]);
    // Private columns are excluded from the HTTP-addressable surface entirely:
    // not filterable, not selectable. The entity client enforces the same
    // policy for default reads; this set protects the parsing layer.
    const cols = new Set(
      Object.entries(table.$columns)
        .filter(([, meta]) => meta.private !== true)
        .map(([colName]) => colName),
    );
    const kinds = buildColumnKindMap(table, cols);
    const pkColumn = derivePkColumnName(table);
    const pkKind = pkColumn ? (kinds.get(pkColumn) ?? "unknown") : "unknown";

    // Six conventional routes per entity. A verb set to `false` is skipped
    // entirely so disabled endpoints are not present in Express at all.
    if (access.list !== false)
      this.bindList(router, name, cols, kinds, access.list);
    if (access.count !== false)
      this.bindCount(router, name, cols, kinds, access.count);
    if (access.find !== false)
      this.bindFind(router, name, cols, kinds, pkKind, access.find);
    if (access.create !== false) this.bindCreate(router, name, access.create);
    if (access.update !== false)
      this.bindUpdate(router, name, pkKind, access.update);
    if (access.delete !== false)
      this.bindDelete(router, name, pkKind, access.delete);
  }
  private bindList(
    router: IAppRouter,
    name: string,
    cols: ReadonlySet<string>,
    kinds: ReadonlyMap<string, ColumnKind>,
    access: HttpAccess,
  ): void {
    this.bind(router, name, "list", "get", `/${name}`, async (req, res) => {
      let q = this.entity(req, access, name);
      q = applyFilters(q, req.query, cols, kinds);
      q = applySelect(q, req.query.select, cols);
      q = applyInclude(
        q,
        req.query.include,
        this.options.schema,
        this.options.config,
      );
      if (typeof req.query.order === "string") {
        q = applyOrder(q, req.query.order, cols);
      }
      q = q.limit(
        typeof req.query.limit === "string"
          ? clampLimit(Number(req.query.limit))
          : DEFAULT_LIMIT,
      );
      if (typeof req.query.offset === "string") {
        const offset = Number(req.query.offset);
        if (Number.isFinite(offset) && offset >= 0) {
          q = q.offset(offset);
        }
      }
      res.json(await q.toArray());
    });
  }
  private bindCount(
    router: IAppRouter,
    name: string,
    cols: ReadonlySet<string>,
    kinds: ReadonlyMap<string, ColumnKind>,
    access: HttpAccess,
  ): void {
    this.bind(
      router,
      name,
      "count",
      "get",
      `/${name}/count`,
      async (req, res) => {
        // Count supports the same column filters as list, but intentionally
        // ignores pagination and select/order shape controls.
        const q = applyFilters(
          this.entity(req, access, name),
          req.query,
          cols,
          kinds,
        );
        res.json({ count: await q.count() });
      },
    );
  }
  private bindFind(
    router: IAppRouter,
    name: string,
    cols: ReadonlySet<string>,
    _kinds: ReadonlyMap<string, ColumnKind>,
    pkKind: ColumnKind,
    access: HttpAccess,
  ): void {
    this.bind(router, name, "find", "get", `/${name}/:id`, async (req, res) => {
      let q = this.entity(req, access, name);
      q = applySelect(q, req.query.select, cols);
      q = applyInclude(
        q,
        req.query.include,
        this.options.schema,
        this.options.config,
      );
      const row = await q.find(coerceId(req.params.id, pkKind));
      if (!row) {
        res.status(404).json({ error: `${name} not found` });
        return;
      }
      res.json(row);
    });
  }
  private bindCreate(
    router: IAppRouter,
    name: string,
    access: HttpAccess,
  ): void {
    this.bind(router, name, "create", "post", `/${name}`, async (req, res) => {
      // PostgREST-compatible upsert: a POST carrying `Prefer:
      // resolution=merge-duplicates` plus `?on_conflict=<column>` is treated as
      // INSERT ... ON CONFLICT DO UPDATE. Lets the browser client share one
      // verb (POST) for both create and upsert.
      const prefer = String(req.header("prefer") ?? "").toLowerCase();
      const onConflict = req.query.on_conflict;
      if (
        prefer.includes("resolution=merge-duplicates") &&
        typeof onConflict === "string" &&
        onConflict
      ) {
        const row = await this.entity(req, access, name).upsert(
          req.body as Record<string, unknown>,
          { onConflict },
        );
        res.status(200).json(row);
        return;
      }

      const row = await this.entity(req, access, name).create(
        req.body as Record<string, unknown>,
      );
      res.status(201).json(row);
    });
  }
  private bindUpdate(
    router: IAppRouter,
    name: string,
    pkKind: ColumnKind,
    access: HttpAccess,
  ): void {
    this.bind(
      router,
      name,
      "update",
      "patch",
      `/${name}/:id`,
      async (req, res) => {
        const row = await this.entity(req, access, name).update(
          coerceId(req.params.id, pkKind),
          req.body as Partial<Record<string, unknown>>,
        );
        res.json(row);
      },
    );
  }
  private bindDelete(
    router: IAppRouter,
    name: string,
    pkKind: ColumnKind,
    access: HttpAccess,
  ): void {
    this.bind(
      router,
      name,
      "delete",
      "delete",
      `/${name}/:id`,
      async (req, res) => {
        await this.entity(req, access, name).delete(
          coerceId(req.params.id, pkKind),
        );
        res.status(204).end();
      },
    );
  }
  private entity(
    req: express.Request,
    access: HttpAccess,
    name: string,
  ): EntityClient {
    // `public` and `service` both resolve to the SP entity surface today. The
    // distinction is still kept in config so future policy/logging can treat
    // them differently without changing route registration.
    const entity = this.options.getSurface(req, access)[name];
    if (!entity) {
      throw new Error(`Database entity "${name}" is not available`);
    }
    return entity;
  }
  private bind(
    router: IAppRouter,
    entity: string,
    verb: Verb,
    method: "get" | "post" | "patch" | "delete",
    path: string,
    handler: (req: express.Request, res: express.Response) => Promise<void>,
  ): void {
    // Central route wrapper: Plugin#route handles endpoint registration, while
    // this wrapper keeps generated handlers from leaking raw exceptions.
    this.options.route(router, {
      name: `${entity}.${verb}`,
      method,
      path,
      handler: async (req, res) => {
        try {
          await handler(req, res);
        } catch (error) {
          logger.error("database route %s %s failed: %O", method, path, error);
          if (error instanceof ZodError) {
            res.status(400).json({ errors: error.format() });
            return;
          }
          // AppKitError messages are author-controlled (404/409/etc) and safe.
          // DatabaseRouteError carries the status from Plugin#execute (already
          // scrubbed for prod). Anything else is a raw thrown Error — show its
          // message in dev, scrub to "Server error" in prod to avoid leaking
          // stack/internal hints.
          if (error instanceof AppKitError) {
            res.status(error.statusCode).json({ error: error.message });
            return;
          }
          if (error instanceof DatabaseRouteError) {
            res.status(error.statusCode).json({ error: error.message });
            return;
          }
          const fallback =
            process.env.NODE_ENV === "production"
              ? "Server error"
              : error instanceof Error
                ? error.message
                : "Server error";
          res.status(500).json({ error: fallback });
        }
      },
    });
  }
}
function resolveAccess(
  override?: HttpEntityOverride,
): Record<Verb, HttpAccess> {
  // Missing config is intentionally not "public". App authors must opt into
  // non-OBO HTTP exposure verb by verb.
  return { ...DEFAULT_ACCESS, ...override };
}

function applyFilters(
  q: EntityClient,
  query: express.Request["query"],
  cols: ReadonlySet<string>,
  kinds: ReadonlyMap<string, ColumnKind>,
): EntityClient {
  let next = q;

  // Query params follow `column=operator.value`. Params for undeclared columns
  // are ignored rather than forwarded, which avoids accidentally exposing
  // hidden columns as filterable HTTP surface.
  for (const [key, raw] of Object.entries(query)) {
    if (RESERVED_QUERY_KEYS.has(key) || !cols.has(key)) continue;
    const kind = kinds.get(key) ?? "unknown";
    const values = Array.isArray(raw) ? raw : [raw];
    const decoded: unknown[] = [];
    for (const v of values) {
      const value = String(v);
      const dot = value.indexOf(".");
      if (dot < 0) {
        decoded.push(coerceScalarTyped(value, kind));
        continue;
      }
      const op = value.slice(0, dot);
      if (!ALLOWED_OPS.has(op)) continue;
      decoded.push({ [op]: coerceFilterValue(op, value.slice(dot + 1), kind) });
    }
    if (decoded.length === 0) continue;
    if (decoded.length === 1) {
      const only = decoded[0];
      next = next.where({
        [key]:
          typeof only === "object" && only !== null && !Array.isArray(only)
            ? (only as Record<string, unknown>)
            : (only as unknown),
      } as WhereInput<Record<string, unknown>>);
      continue;
    }
    // Multiple values for the same key: prefer to AND them together by merging
    // every decoded predicate (`?col=eq.a&col=neq.b` means both). When every
    // entry is a bare scalar, treat it as `IN (...)` for the natural duplicate
    // shape used by HTML forms (`col=a&col=b`).
    const allScalars = decoded.every(
      (d) => typeof d !== "object" || d === null || Array.isArray(d),
    );
    if (allScalars) {
      next = next.where({
        [key]: { in: decoded },
      } as WhereInput<Record<string, unknown>>);
      continue;
    }
    const merged: Record<string, unknown> = {};
    for (const entry of decoded) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry)
      ) {
        Object.assign(merged, entry);
      }
    }
    next = next.where({ [key]: merged } as WhereInput<Record<string, unknown>>);
  }
  return next;
}
/**
 * Validate `?select=col1,col2` against the schema's columns and project.
 * Unknown columns are dropped silently — same posture as `applyFilters` so
 * undeclared columns never become HTTP-addressable.
 */
function applySelect(
  q: EntityClient,
  raw: unknown,
  cols: ReadonlySet<string>,
): EntityClient {
  if (typeof raw !== "string" || raw.length === 0) return q;
  const picked = raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => cols.has(c));
  return picked.length > 0 ? q.select(...picked) : q;
}

/**
 * Parse `?include=posts,author` (or `?include=posts(id,title),author(name)`)
 * and forward to `entity.include({ ... })`. The runtime resolves relation
 * names against the schema's `$relations` metadata; unknown names throw at
 * query time, so this parser intentionally trusts the caller.
 */
function applyInclude(
  q: EntityClient,
  raw: unknown,
  schema: Schema,
  config: IDatabaseConfig,
): EntityClient {
  if (typeof raw !== "string" || raw.length === 0) return q;
  const include = parseIncludeSpec(raw);

  // Strip select columns that don't exist on the related table or are
  // private. Keeps `?include=author(password_hash)` from leaking secrets.
  // Unknown relation names are passed through — the runtime layer is
  // authoritative about what relations exist and rejects them at query time.
  for (const [relation, spec] of Object.entries(include)) {
    if (spec === true) continue;
    const relatedTable = schema.$tables[relation];
    if (!relatedTable) continue;
    const allow = new Set(
      Object.entries(relatedTable.$columns)
        .filter(
          ([, meta]) =>
            meta.private !== true && config.http?.[relation]?.list !== false,
        )
        .map(([colName]) => colName),
    );
    spec.select = spec.select.filter((c) => allow.has(c));
  }

  return Object.keys(include).length > 0
    ? (q.include(include) as EntityClient)
    : q;
}

/**
 * Tokenise an `?include=` value into `{ relation: true | { select: [...] } }`.
 * Splits on top-level commas (paren-aware) and parses each `name(col,col)`
 * fragment. Whitespace is trimmed everywhere; empty fragments are skipped.
 */
function parseIncludeSpec(
  raw: string,
): Record<string, true | { select: string[] }> {
  const out: Record<string, true | { select: string[] }> = {};
  let depth = 0;
  let buf = "";
  const fragments: string[] = [];
  for (const ch of raw) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      fragments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) fragments.push(buf);

  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (!trimmed) continue;
    const open = trimmed.indexOf("(");
    if (open < 0) {
      out[trimmed] = true;
      continue;
    }
    const close = trimmed.lastIndexOf(")");
    const relation = trimmed.slice(0, open).trim();
    if (!relation) continue;
    const inner = close > open ? trimmed.slice(open + 1, close) : "";
    const select = inner
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    out[relation] = select.length > 0 ? { select } : true;
  }
  return out;
}

function applyOrder(
  q: EntityClient,
  raw: string,
  cols: ReadonlySet<string>,
): EntityClient {
  const order: Record<string, "asc" | "desc"> = {};

  // PostGREST-style order list: `?order=email.desc,createdAt.asc`.
  // Unknown columns are skipped for the same reason filters are constrained.
  for (const clause of raw.split(",")) {
    const [column, direction] = clause.split(".");
    if (!cols.has(column)) continue;
    order[column] = direction === "desc" ? "desc" : "asc";
  }
  return Object.keys(order).length ? q.order(order) : q;
}
function clampLimit(value: number): number {
  // Hard clamp keeps accidental large browser reads from turning into expensive
  // table scans. Callers that need more should page explicitly.
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(value));
}
function coerceFilterValue(
  op: string,
  value: string,
  kind: ColumnKind,
): unknown {
  if (op === "in") {
    // Support both `in.(a,b)` and `in.a,b` shapes; the former matches PostGREST
    // URLs while the latter is a little easier to type by hand.
    const body =
      value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
    return splitList(body).map((part) => coerceScalarTyped(part, kind));
  }
  if (op === "like" || op === "ilike") return value;
  return coerceScalarTyped(value, kind);
}
/**
 * Type-aware scalar coercion for filter values pulled out of the query string.
 *
 * Text/uuid/json columns get the raw string back so a value like `"true"`,
 * `"null"`, or `"42"` is filtered as the literal string the user typed.
 * Number/boolean/date columns get the same heuristic as before so
 * `?count=eq.42` still works.
 */
function coerceScalarTyped(value: string, kind: ColumnKind): unknown {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (kind === "text" || kind === "uuid" || kind === "json") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (
    (kind === "number" || kind === "unknown") &&
    value !== "" &&
    !Number.isNaN(Number(value))
  ) {
    return Number(value);
  }
  return value;
}
function coerceScalar(value: string): unknown {
  // Kept for callers that have no column-kind context. Behaves like the old
  // heuristic — prefer `coerceScalarTyped(value, kind)` when the column kind
  // is available so we don't reinterpret strings on text columns.
  return coerceScalarTyped(value, "unknown");
}
function splitList(value: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuotes) {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }

  out.push(buf);
  return out;
}
function coerceId(raw: string, kind: ColumnKind): string | number {
  // Honor the declared PK type. Text/uuid PKs that happen to look numeric
  // (`"123"`) used to be silently turned into numbers — now they pass through.
  if (kind === "text" || kind === "uuid") return raw;
  const numberValue = Number(raw);
  return Number.isFinite(numberValue) && String(numberValue) === raw
    ? numberValue
    : raw;
}

function derivePkColumnName(table: AppKitTable): string | null {
  for (const [name, meta] of Object.entries(table.$columns)) {
    if (meta.primaryKey) return name;
  }
  return Object.keys(table.$columns).includes("id") ? "id" : null;
}

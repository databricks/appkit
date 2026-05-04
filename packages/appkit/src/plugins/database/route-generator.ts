import type express from "express";
import type { IAppRouter, RouteConfig } from "shared";
import { ZodError } from "zod";
import type { AppKitTable, Schema } from "@/database";
import { AppKitError } from "@/errors";
import { createLogger } from "@/logging/logger";
import { describeEntityColumns } from "./columns-route";
import { DatabaseRouteError } from "./database";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./defaults";
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
 * Classify a column from Drizzle's `columnType` so `coerceFilterValue`/`coerceId`
 * don't over-coerce on text/uuid. Hand-rolled to keep this file out of the
 * drizzle-orm import graph — `$drizzle` is `unknown` at the AppKit boundary.
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

// Read-shape controls; everything else is a potential column filter (if declared).
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
   * Identity selection lives in DatabasePlugin; this generator only forwards
   * the configured access mode and uses the returned entity map.
   */
  getSurface: (
    req: express.Request,
    access: HttpAccess,
  ) => DatabaseExecutionSurface;
  /** SP pool for the `_healthz` `SELECT 1`. Optional for tests without a pool. */
  getServicePool?: () => import("pg").Pool;
  /** Bound wrapper around Plugin#route so endpoint registration stays central. */
  route: (router: IAppRouter, config: RouteConfig) => void;
}

/**
 * HTTP layer for every schema table. Translates Express requests into the
 * EntityClient API — no PostGREST client, pool, or auth internals here.
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
   * `GET /api/database/_healthz` — SP `SELECT 1` + `{ ok, poolStats }`.
   * Always public: readiness probes from k8s/LB don't carry user auth.
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
        const pool = getPool();
        // Detect saturation BEFORE pool.query — that call blocks on connect()
        // up to `connectionTimeoutMillis` under load, exceeding typical k8s
        // probe timeouts and stealing a real conn slot from app traffic.
        const poolMax =
          (pool as unknown as { options?: { max?: number } }).options?.max ??
          Number.POSITIVE_INFINITY;
        const saturated =
          pool.totalCount >= poolMax &&
          pool.idleCount === 0 &&
          pool.waitingCount > 0;
        if (saturated) {
          res.status(503).json({
            ok: false,
            reason: "pool saturated",
            poolStats: {
              total: pool.totalCount,
              idle: pool.idleCount,
              waiting: pool.waitingCount,
            },
          });
          return;
        }
        // 1s race so a slow `SELECT 1` doesn't pin the probe past LB timeout.
        const probe = pool.query("SELECT 1");
        const timeout = new Promise<"timeout">((resolve) => {
          const t = setTimeout(() => resolve("timeout"), 1_000);
          t.unref?.();
        });
        try {
          const result = await Promise.race([probe, timeout]);
          if (result === "timeout") {
            res.status(503).json({ ok: false, reason: "probe timeout" });
            return;
          }
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
    // Private columns are off the HTTP surface entirely (not filterable, not
    // selectable). EntityClient enforces this for reads; this set guards parsing.
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
    if (access.create !== false)
      this.bindCreate(router, name, cols, access.create);
    if (access.update !== false)
      this.bindUpdate(router, name, pkKind, access.update);
    if (access.delete !== false)
      this.bindDelete(router, name, pkKind, access.delete);


    // `_columns` is a pure-metadata read derived from the declared schema.
    // It doesn't consume a verb slot in the access config — it's keyed on
    // `list` so disabling list hides _columns too, which matches "this
    // entity is not browsable over HTTP".
    if (access.list !== false) this.bindColumns(router, name, table);
  }

  /**
   * Expose a compact `ColumnInfo[]` description of the entity so the browser
   * can auto-render edit/create forms. Handler is synchronous data derived
   * from `schema.ts` — no pool, no token — so we bypass `this.bind`'s entity
   * lookup but keep its error-to-JSON wrapping for consistent failure shape.
   */
  private bindColumns(
    router: IAppRouter,
    name: string,
    table: AppKitTable,
  ): void {
    // Describe once at registration; the result is stable for the plugin's
    // lifetime because schema.ts does not change at runtime.
    const columns = describeEntityColumns(table);
    this.options.route(router, {
      name: `${name}.columns`,
      method: "get",
      path: `/${name}/_columns`,
      handler: async (_req, res) => {
        res.json(columns);
      },
    });
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
        // Same filters as list — ignores pagination and shape controls.
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
    cols: ReadonlySet<string>,
    access: HttpAccess,
  ): void {
    this.bind(router, name, "create", "post", `/${name}`, async (req, res) => {
      // PostgREST-style upsert: POST + `Prefer: resolution=merge-duplicates`
      // + `?on_conflict=<col>` → INSERT ... ON CONFLICT DO UPDATE. Lets the
      // browser share one verb for create/upsert.
      const prefer = String(req.header("prefer") ?? "").toLowerCase();
      const onConflict = req.query.on_conflict;
      if (
        prefer.includes("resolution=merge-duplicates") &&
        typeof onConflict === "string" &&
        onConflict
      ) {
        // Allowlist vs the public column set — rejects private/proto-pollution/
        // unknown names before they reach Drizzle internals.
        if (!cols.has(onConflict)) {
          res
            .status(400)
            .json({ error: `Unknown on_conflict column for ${name}` });
          return;
        }
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
    // `public` and `service` both → SP surface today; kept distinct for future
    // policy/logging without changing route registration.
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
          // AppKitError: author-controlled, safe to show. DatabaseRouteError
          // carries status from Plugin#execute (already scrubbed in prod).
          // Anything else is raw — show in dev, scrub in prod to avoid leaking
          // stack/internals.
          if (error instanceof AppKitError) {
            res.status(error.statusCode).json({ error: error.message });
            return;
          }
          if (error instanceof DatabaseRouteError) {
            res.status(error.statusCode).json({ error: error.message });
            return;
          }
          // pg/Drizzle errors carry SQLSTATE in `code`. Map common cases to
          // sane HTTP status codes; everything else falls through to 500.
          const pgCode = (error as { code?: unknown }).code;
          if (typeof pgCode === "string") {
            const status = pgErrorToHttpStatus(pgCode);
            if (status) {
              const message =
                process.env.NODE_ENV === "production"
                  ? defaultMessageForStatus(status)
                  : error instanceof Error
                    ? error.message
                    : defaultMessageForStatus(status);
              res.status(status).json({ error: message });
              return;
            }
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

  // Query params: `column=operator.value`. Undeclared columns are ignored so
  // hidden columns don't accidentally become HTTP-filterable.
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
    // Multiple values for the same key. When every entry is a bare scalar,
    // treat as `IN (...)` to match HTML form `col=a&col=b`.
    const allScalars = decoded.every(
      (d) => typeof d !== "object" || d === null || Array.isArray(d),
    );
    if (allScalars) {
      next = next.where({
        [key]: { in: decoded },
      } as WhereInput<Record<string, unknown>>);
      continue;
    }
    // Duplicate operators on one key would clobber via shallow-merge. Promote
    // duplicate `eq` to `in: [values]` so intent isn't silently dropped;
    // mixed-operator dups (eq + neq) still merge — last write per op wins.
    const eqValues: unknown[] = [];
    const merged: Record<string, unknown> = {};
    for (const entry of decoded) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        "eq" in entry &&
        Object.keys(entry).length === 1
      ) {
        eqValues.push((entry as { eq: unknown }).eq);
        continue;
      }
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry)
      ) {
        Object.assign(merged, entry);
      }
    }
    if (eqValues.length > 1) merged.in = eqValues;
    else if (eqValues.length === 1) merged.eq = eqValues[0];
    next = next.where({ [key]: merged } as WhereInput<Record<string, unknown>>);
  }
  return next;
}
/**
 * Validate `?select=` and project. Unknown columns drop silently — same
 * posture as `applyFilters` to keep undeclared columns off the HTTP surface.
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
 * Parse `?include=posts,author` (or `posts(id,title),author(name)`) and forward
 * to `entity.include({ ... })`. Relation names are resolved at query time —
 * unknown names throw there, so this parser trusts the caller.
 */
function applyInclude(
  q: EntityClient,
  raw: unknown,
  schema: Schema,
  config: IDatabaseConfig,
): EntityClient {
  if (typeof raw !== "string" || raw.length === 0) return q;
  const include = parseIncludeSpec(raw);

  // Strip private/unknown select cols on related tables — keeps
  // `?include=author(password_hash)` from leaking secrets. Unknown relation
  // names pass through; the runtime is authoritative and rejects at query time.
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
 * Tokenise `?include=` into `{ relation: true | { select: [...] } }`. Splits
 * on top-level (paren-aware) commas; whitespace trimmed; empty fragments dropped.
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
    if (ch === ")") {
      // Reject unbalanced `?include=)foo` rather than letting depth go negative
      // and silently treating subsequent commas as fragment separators.
      if (depth === 0) return {};
      depth--;
    }
    if (ch === "," && depth === 0) {
      fragments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  // Unclosed `?include=foo(` — drop rather than emit a partial spec.
  if (depth !== 0) return {};
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
 * Type-aware scalar coercion. Text/uuid/json get the raw string (`"true"`,
 * `"null"`, `"42"` stay literal); number/boolean/date go through the heuristic
 * so `?count=eq.42` still works.
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
// No-kind fallback — prefer `coerceScalarTyped(value, kind)` when available
// so strings on text columns aren't reinterpreted.
function coerceScalar(value: string): unknown {
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

// Map common pg SQLSTATE codes to HTTP status. Returns `null` to mean "fall
// through to 500".
function pgErrorToHttpStatus(code: string): number | null {
  switch (code) {
    case "23505": // unique_violation
      return 409;
    case "23503": // foreign_key_violation
    case "23514": // check_violation
    case "23502": // not_null_violation
    case "22P02": // invalid_text_representation
      return 400;
    case "42501": // insufficient_privilege (RLS denial, missing GRANT)
      return 403;
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected
      return 503;
    default:
      return null;
  }
}

function defaultMessageForStatus(status: number): string {
  if (status === 409) return "Conflict";
  if (status === 400) return "Bad request";
  if (status === 403) return "Forbidden";
  if (status === 503) return "Service temporarily unavailable";
  return "Server error";
}

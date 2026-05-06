import type express from "express";
import type { IAppRouter, RouteConfig } from "shared";
import { ZodError } from "zod";
import type { AppKitTable, Schema } from "@/database";
import { AppKitError } from "@/errors";
import { createLogger } from "@/logging/logger";
import { describeAllEntities } from "./columns-route";
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

/** Hand-rolled to keep drizzle-orm out of this file's import graph. */
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

// Default OBO; app authors must opt verbs into service/public/disabled.
const DEFAULT_ACCESS: Record<Verb, HttpAccess> = {
  list: "obo",
  find: "obo",
  count: "obo",
  create: "obo",
  update: "obo",
  delete: "obo",
};

// Read-shape controls; anything else may be a column filter.
const RESERVED_QUERY_KEYS = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "include",
  "on_conflict",
]);

// PostGREST dialect: `?age=gte.18`, `?name=ilike.%foo%`, `?id=in.(1,2,3)`.
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
  /** Identity selection lives in DatabasePlugin; we just forward the access mode. */
  getSurface: (
    req: express.Request,
    access: HttpAccess,
  ) => DatabaseExecutionSurface;
  /** SP pool for `_healthz`'s `SELECT 1`. Optional for pool-less tests. */
  getServicePool?: () => import("pg").Pool;
  /** Bound wrapper around `Plugin#route`. */
  route: (router: IAppRouter, config: RouteConfig) => void;
}

/** Generates the HTTP layer for every schema table over `EntityClient`. */
export class RouteGenerator {
  constructor(private readonly options: RouteGeneratorOptions) {}

  injectAll(router: IAppRouter): void {
    this.bindHealth(router);
    this.bindEntities(router);
    for (const [name, table] of Object.entries(this.options.schema.$tables)) {
      this.injectEntity(router, name, table);
    }
  }

  /** `GET /_entities`: schema discovery, pre-computed at registration. */
  private bindEntities(router: IAppRouter): void {
    if (this.options.config.entitiesDiscovery === false) return;
    const entities = describeAllEntities(this.options.schema).filter(
      (e) => resolveAccess(this.options.config.http?.[e.name]).list !== false,
    );
    this.options.route(router, {
      name: "database._entities",
      method: "get",
      path: "/_entities",
      handler: async (_req, res) => {
        res.json({ entities });
      },
    });
  }

  /** `GET /_healthz`: saturation pre-check + 1s-bounded `SELECT 1`. */
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
        // and would steal a real conn slot.
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
        // 1s cap so a slow probe doesn't blow the LB timeout.
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
    // Private columns are off the HTTP surface (not filterable, not selectable).
    const cols = new Set(
      Object.entries(table.$columns)
        .filter(([, meta]) => meta.private !== true)
        .map(([colName]) => colName),
    );
    const kinds = buildColumnKindMap(table, cols);
    const pkColumn = derivePkColumnName(table);
    const pkKind = pkColumn ? (kinds.get(pkColumn) ?? "unknown") : "unknown";

    // Six routes per entity; `false` skips registration entirely.
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
      // + `?on_conflict=<col>` → ON CONFLICT DO UPDATE.
      const prefer = String(req.header("prefer") ?? "").toLowerCase();
      const onConflict = req.query.on_conflict;
      if (
        prefer.includes("resolution=merge-duplicates") &&
        typeof onConflict === "string" &&
        onConflict
      ) {
        // Reject private/proto-pollution/unknown names before they reach Drizzle.
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
    // `public`/`service` resolve to SP today; kept distinct for future policy.
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
    // Central wrapper so generated handlers don't leak raw exceptions.
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
          // AppKitError + DatabaseRouteError: message is safe; raw errors get
          // scrubbed in prod to avoid leaking stack/internals.
          if (error instanceof AppKitError) {
            res.status(error.statusCode).json({ error: error.message });
            return;
          }
          if (error instanceof DatabaseRouteError) {
            res.status(error.statusCode).json({ error: error.message });
            return;
          }
          // pg/Drizzle SQLSTATE → HTTP status; unmapped codes fall through to 500.
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
  return { ...DEFAULT_ACCESS, ...override };
}

function applyFilters(
  q: EntityClient,
  query: express.Request["query"],
  cols: ReadonlySet<string>,
  kinds: ReadonlyMap<string, ColumnKind>,
): EntityClient {
  let next = q;

  // `?column=operator.value`. Undeclared columns are silently ignored.
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
    // Multiple bare scalars on one key → `IN (...)` (matches `col=a&col=b`).
    const allScalars = decoded.every(
      (d) => typeof d !== "object" || d === null || Array.isArray(d),
    );
    if (allScalars) {
      next = next.where({
        [key]: { in: decoded },
      } as WhereInput<Record<string, unknown>>);
      continue;
    }
    // Promote duplicate `eq` to `in: [values]`; mixed ops merge (last write wins).
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
/** `?select=col,col`. Unknown columns drop silently (same as `applyFilters`). */
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

/** `?include=posts,author` or `posts(id,title),author(name)`. */
function applyInclude(
  q: EntityClient,
  raw: unknown,
  schema: Schema,
  config: IDatabaseConfig,
): EntityClient {
  if (typeof raw !== "string" || raw.length === 0) return q;
  const include = parseIncludeSpec(raw);

  // Strip private/unknown select cols on related tables so
  // `?include=author(password_hash)` can't leak.
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

/** Paren-aware tokenizer for `?include=`. Returns `{}` on unbalanced input. */
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

/** `?order=email.desc,createdAt.asc`. Unknown columns dropped. */
function applyOrder(
  q: EntityClient,
  raw: string,
  cols: ReadonlySet<string>,
): EntityClient {
  const order: Record<string, "asc" | "desc"> = {};

  for (const clause of raw.split(",")) {
    const [column, direction] = clause.split(".");
    if (!cols.has(column)) continue;
    order[column] = direction === "desc" ? "desc" : "asc";
  }
  return Object.keys(order).length ? q.order(order) : q;
}
/** Hard cap so accidental huge reads don't turn into table scans. */
function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(value));
}
function coerceFilterValue(
  op: string,
  value: string,
  kind: ColumnKind,
): unknown {
  if (op === "in") {
    // Accept both `in.(a,b)` (PostGREST) and `in.a,b` (terser).
    const body =
      value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
    return splitList(body).map((part) => coerceScalarTyped(part, kind));
  }
  if (op === "like" || op === "ilike") return value;
  return coerceScalarTyped(value, kind);
}
/** Text/uuid/json keep raw string; number/boolean/date go through heuristics. */
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
/** Honor the declared PK type so numeric-looking text PKs aren't coerced. */
function coerceId(raw: string, kind: ColumnKind): string | number {
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

/** pg SQLSTATE → HTTP status. `null` falls through to 500. */
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

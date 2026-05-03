import type express from "express";
import type { IAppRouter, RouteConfig } from "shared";
import type { AppKitTable, Schema } from "@/database";
import { createLogger } from "@/logging/logger";
import type { EntityClient, WhereInput } from "./entity-proxy";
import type { HttpAccess, HttpEntityOverride, IDatabaseConfig } from "./types";

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
const RESERVED_QUERY_KEYS = new Set(["select", "order", "limit", "offset"]);

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
  /** Bound wrapper around Plugin#route so endpoint registration stays central. */
  route: (router: IAppRouter, config: RouteConfig) => void;
}

/**
 * Generates the HTTP layer for every schema table.
 *
 * This class deliberately does not know about PostGREST clients, pg pools, or
 * auth internals. It translates Express requests into the L3 EntityClient API;
 * the entity client then handles validation, hooks, execute wrapping, retries,
 * cache, telemetry, and PostGREST calls.
 */
export class RouteGenerator {
  constructor(private readonly options: RouteGeneratorOptions) {}

  injectAll(router: IAppRouter): void {
    for (const [name, table] of Object.entries(this.options.schema.$tables)) {
      this.injectEntity(router, name, table);
    }
  }

  private injectEntity(
    router: IAppRouter,
    name: string,
    table: AppKitTable,
  ): void {
    const access = resolveAccess(this.options.config.http?.[name]);
    const cols = new Set(Object.keys(table.$columns));

    // Six conventional routes per entity. A verb set to `false` is skipped
    // entirely so disabled endpoints are not present in Express at all.
    if (access.list !== false) this.bindList(router, name, cols, access.list);
    if (access.count !== false)
      this.bindCount(router, name, cols, access.count);
    if (access.find !== false) this.bindFind(router, name, access.find);
    if (access.create !== false)
      this.bindCreate(router, name, table, access.create);
    if (access.update !== false)
      this.bindUpdate(router, name, table, access.update);
    if (access.delete !== false) this.bindDelete(router, name, access.delete);
  }
  private bindList(
    router: IAppRouter,
    name: string,
    cols: ReadonlySet<string>,
    access: HttpAccess,
  ): void {
    this.bind(router, name, "list", "get", `/${name}`, async (req, res) => {
      let q = this.entity(req, access, name);

      // Filters are applied inline here on purpose. A separate parser would just
      // duplicate PostGREST's operator vocabulary and create another abstraction
      // to keep in sync.
      q = applyFilters(q, req.query, cols);

      // Forward `?select=*,posts(*)` and plain column lists to EntityClient's raw
      // select overload. This is what lets browser `.include()` work end to end.
      if (typeof req.query.select === "string") {
        q = q.select(req.query.select);
      }
      if (typeof req.query.order === "string") {
        q = applyOrder(q, req.query.order, cols);
      }
      q = q.limit(
        typeof req.query.limit === "string"
          ? clampLimit(Number(req.query.limit))
          : DEFAULT_LIMIT,
      );

      // EntityClient defers offset+limit translation into PostGREST range().
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
        const q = applyFilters(this.entity(req, access, name), req.query, cols);
        res.json({ count: await q.count() });
      },
    );
  }
  private bindFind(router: IAppRouter, name: string, access: HttpAccess): void {
    this.bind(router, name, "find", "get", `/${name}/:id`, async (req, res) => {
      let q = this.entity(req, access, name);

      // Useful for embedded reads like /user/1?select=*,posts(*).
      if (typeof req.query.select === "string") {
        q = q.select(req.query.select);
      }
      const row = await q.find(coerceId(req.params.id));
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
    table: AppKitTable,
    access: HttpAccess,
  ): void {
    this.bind(router, name, "create", "post", `/${name}`, async (req, res) => {
      // Validate at the route boundary so bad browser requests get a 400 with
      // structured Zod errors before hooks or database work run.
      const parsed = table.$insertSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ errors: parsed.error.format() });
        return;
      }

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
          parsed.data as Record<string, unknown>,
          { onConflict },
        );
        res.status(200).json(row);
        return;
      }

      const row = await this.entity(req, access, name).create(
        parsed.data as Record<string, unknown>,
      );
      res.status(201).json(row);
    });
  }
  private bindUpdate(
    router: IAppRouter,
    name: string,
    table: AppKitTable,
    access: HttpAccess,
  ): void {
    this.bind(
      router,
      name,
      "update",
      "patch",
      `/${name}/:id`,
      async (req, res) => {
        // Same boundary validation as create(), but using the update schema so
        // partial patches are accepted.
        const parsed = table.$updateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ errors: parsed.error.format() });
          return;
        }
        const row = await this.entity(req, access, name).update(
          coerceId(req.params.id),
          parsed.data as Partial<Record<string, unknown>>,
        );
        res.json(row);
      },
    );
  }
  private bindDelete(
    router: IAppRouter,
    name: string,
    access: HttpAccess,
  ): void {
    this.bind(
      router,
      name,
      "delete",
      "delete",
      `/${name}/:id`,
      async (req, res) => {
        await this.entity(req, access, name).delete(coerceId(req.params.id));
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
          res.status(500).json({
            error: error instanceof Error ? error.message : "Server error",
          });
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
): EntityClient {
  let next = q;

  // Query params follow `column=operator.value`. Params for undeclared columns
  // are ignored rather than forwarded, which avoids accidentally exposing
  // hidden columns as filterable HTTP surface.
  for (const [key, raw] of Object.entries(query)) {
    if (RESERVED_QUERY_KEYS.has(key) || !cols.has(key)) continue;
    const value = String(Array.isArray(raw) ? raw[0] : raw);
    const dot = value.indexOf(".");
    if (dot < 0) {
      // Bare `?role=admin` is shorthand for `eq.admin`.
      next = next.where({ [key]: coerceScalar(value) } as WhereInput<
        Record<string, unknown>
      >);
      continue;
    }
    const op = value.slice(0, dot);
    if (!ALLOWED_OPS.has(op)) continue;
    next = next.where({
      [key]: { [op]: coerceFilterValue(op, value.slice(dot + 1)) },
    } as WhereInput<Record<string, unknown>>);
  }
  return next;
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
function coerceFilterValue(op: string, value: string): unknown {
  if (op === "in") {
    // Support both `in.(a,b)` and `in.a,b` shapes; the former matches PostGREST
    // URLs while the latter is a little easier to type by hand.
    const body =
      value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
    return body.split(",").map(coerceScalar);
  }
  return coerceScalar(value);
}
function coerceScalar(value: string): unknown {
  // Keep coercion intentionally small and predictable. Anything more complex
  // should be expressed by the client as a string and interpreted by Postgres.
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}
function coerceId(raw: string): string | number {
  // Numeric path ids become numbers so serial primary keys behave naturally;
  // UUIDs and other string ids pass through untouched.
  const numberValue = Number(raw);
  return Number.isFinite(numberValue) && String(numberValue) === raw
    ? numberValue
    : raw;
}

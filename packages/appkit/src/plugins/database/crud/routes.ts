import type { Request, Response } from "express";

import {
  DatabasePluginError,
  invalidDatabaseInput,
} from "../../../database/errors";
import type {
  IdValue,
  IncludeSpec,
  OrderSpec,
  Row,
  WhereClause,
} from "../../../database/runtime";
import type { ReadSerializer } from "../types";
import type { JsonValue } from "./codecs";
import type { CrudTable } from "./contract";
import { decodeDetailQuery, decodeListQuery } from "./query";
import { decodeCreateBody, decodeId, decodeUpdateBody } from "./request";
import { sendEmpty, sendError, sendJson, sendListPage } from "./response";

/** The `EntityClient` subset the generated routes drive. */
export interface CrudEntity {
  where(where: WhereClause): CrudEntity;
  order(order: OrderSpec): CrudEntity;
  select(columns: string[]): CrudEntity;
  include(include: IncludeSpec): CrudEntity;
  limit(limit: number): CrudEntity;
  offset(offset: number): CrudEntity;
  toArray(): Promise<Row[]>;
  find(id: IdValue): Promise<Row | null>;
  create(values: Row): Promise<Row>;
  update(id: IdValue, values: Row): Promise<Row | null>;
  delete(id: IdValue): Promise<boolean>;
}

/** Which generated operation a span and its route belong to. */
export type CrudOperation = "list" | "detail" | "create" | "update" | "delete";

/** Everything one table's generated routes need from the plugin instance. */
export interface CrudRouteDeps {
  readonly table: CrudTable;
  /** Resolved per request so a draining plugin cannot serve a stale client. */
  entity(): CrudEntity;
  readonly serialize?: ReadSerializer;
  runRouteSpan(
    operation: CrudOperation,
    route: string,
    run: () => Promise<void>,
  ): Promise<void>;
}

type RouteHandler = (req: Request, res: Response) => Promise<void>;

/** Express normalizes `req.query`; the decoders need the untouched string. */
function rawQuery(req: Request): string {
  const url = req.originalUrl ?? req.url;
  const start = url.indexOf("?");
  return start === -1 ? "" : url.slice(start + 1);
}

/**
 * Append the primary key so equal sort keys cannot reshuffle between pages.
 * A keyless table has no unique tie-breaker to append, so it must order itself
 * and its pages stay stable only while no concurrent write reorders them.
 */
function stableOrder(
  primaryKey: string | undefined,
  order: OrderSpec | undefined,
): OrderSpec {
  if (primaryKey)
    return { ...order, [primaryKey]: order?.[primaryKey] ?? "asc" };
  if (!order) {
    throw invalidDatabaseInput(
      ["order"],
      "A table without a primary key requires an explicit order",
    );
  }
  return order;
}

function serializeRow(
  deps: CrudRouteDeps,
  operation: "list" | "detail",
  row: Row,
): JsonValue {
  const projected = deps.table.projectPublicRow(row);
  if (!deps.serialize) return projected;
  const shaped = deps.serialize(projected as Record<string, unknown>, {
    entity: deps.table.name,
    operation,
  });
  return deps.table.sanitizeSerializedRow(shaped);
}

/**
 * A write takes its whole input from the path and the body. A query string
 * would silently look like a filter, so it is refused rather than ignored.
 */
function assertNoQuery(req: Request): void {
  if (rawQuery(req) !== "") {
    throw invalidDatabaseInput(["query"], "Writes accept no query parameters");
  }
}

/** The body parser only ran if the caller declared JSON. */
function assertJsonBody(req: Request): void {
  if (!req.is("application/json")) {
    throw new DatabasePluginError("UNSUPPORTED_MEDIA_TYPE", "write");
  }
}

/** `GET /:table` — one bounded page in the `{ items, limit, offset }` envelope. */
export function createListHandler(deps: CrudRouteDeps): RouteHandler {
  const primaryKey = deps.table.primaryKey?.meta.columnName;
  const route = `/${deps.table.name}`;

  return async (req, res) => {
    try {
      await deps.runRouteSpan("list", route, async () => {
        const decoded = decodeListQuery(deps.table, rawQuery(req));
        let query = deps
          .entity()
          .order(stableOrder(primaryKey, decoded.order))
          .limit(decoded.limit)
          .offset(decoded.offset);
        if (decoded.where) query = query.where(decoded.where);
        if (decoded.select) query = query.select(decoded.select);
        if (decoded.include) query = query.include(decoded.include);

        const rows = await query.toArray();
        sendListPage(
          res,
          rows,
          (row) => serializeRow(deps, "list", row),
          decoded.limit,
          decoded.offset,
        );
      });
    } catch (error) {
      sendError(res, deps.table, "read", error);
    }
  };
}

/** `GET /:table/:id` — one public row, or 404 when nothing matches. */
export function createDetailHandler(deps: CrudRouteDeps): RouteHandler {
  const route = `/${deps.table.name}/:id`;

  return async (req, res) => {
    try {
      await deps.runRouteSpan("detail", route, async () => {
        const id = decodeId(deps.table, req.params.id);
        const decoded = decodeDetailQuery(deps.table, rawQuery(req));
        let query = deps.entity();
        if (decoded.select) query = query.select(decoded.select);
        if (decoded.include) query = query.include(decoded.include);

        const row = await query.find(id);
        if (row === null) throw new DatabasePluginError("NOT_FOUND", "read");
        sendJson(res, 200, serializeRow(deps, "detail", row));
      });
    } catch (error) {
      sendError(res, deps.table, "read", error);
    }
  };
}

/**
 * `POST /:table` — the created row at `201`. A mutation answers the row the
 * database actually holds, so a read serializer never reshapes it.
 */
export function createCreateHandler(deps: CrudRouteDeps): RouteHandler {
  const route = `/${deps.table.name}`;

  return async (req, res) => {
    try {
      await deps.runRouteSpan("create", route, async () => {
        assertNoQuery(req);
        assertJsonBody(req);
        const values = decodeCreateBody(deps.table, req.body);
        const row = await deps.entity().create(values);
        sendJson(res, 201, deps.table.projectPublicRow(row));
      });
    } catch (error) {
      sendError(res, deps.table, "write", error);
    }
  };
}

/** `PATCH /:table/:id` — the updated row at `200`, or 404 when it is gone. */
export function createUpdateHandler(deps: CrudRouteDeps): RouteHandler {
  const route = `/${deps.table.name}/:id`;

  return async (req, res) => {
    try {
      await deps.runRouteSpan("update", route, async () => {
        assertNoQuery(req);
        assertJsonBody(req);
        const id = decodeId(deps.table, req.params.id);
        const values = decodeUpdateBody(deps.table, req.body);
        const row = await deps.entity().update(id, values);
        if (row === null) throw new DatabasePluginError("NOT_FOUND", "write");
        sendJson(res, 200, deps.table.projectPublicRow(row));
      });
    } catch (error) {
      sendError(res, deps.table, "write", error);
    }
  };
}

/** `DELETE /:table/:id` — `204` with no body, or 404 when nothing matched. */
export function createDeleteHandler(deps: CrudRouteDeps): RouteHandler {
  const route = `/${deps.table.name}/:id`;

  return async (req, res) => {
    try {
      await deps.runRouteSpan("delete", route, async () => {
        assertNoQuery(req);
        const id = decodeId(deps.table, req.params.id);
        const deleted = await deps.entity().delete(id);
        if (!deleted) throw new DatabasePluginError("NOT_FOUND", "write");
        sendEmpty(res, 204);
      });
    } catch (error) {
      sendError(res, deps.table, "write", error);
    }
  };
}

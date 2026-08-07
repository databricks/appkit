import type { Request, Response } from "express";

import {
  classifyDatabaseError,
  type DatabaseErrorDetail,
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
import { MAX_RESPONSE_BYTES } from "../defaults";
import type { ReadSerializer } from "../types";
import type { JsonValue } from "./codecs";
import type { CrudTable } from "./contract";
import { decodeDetailQuery, decodeListQuery } from "./query";

/** The `EntityClient` subset a generated read drives. */
export interface CrudReadEntity {
  where(where: WhereClause): CrudReadEntity;
  order(order: OrderSpec): CrudReadEntity;
  select(columns: string[]): CrudReadEntity;
  include(include: IncludeSpec): CrudReadEntity;
  limit(limit: number): CrudReadEntity;
  offset(offset: number): CrudReadEntity;
  toArray(): Promise<Row[]>;
  find(id: IdValue): Promise<Row | null>;
}

/** Everything one table's generated reads need from the plugin instance. */
export interface ReadRouteDeps {
  readonly table: CrudTable;
  /** Resolved per request so a draining plugin cannot serve a stale client. */
  entity(): CrudReadEntity;
  readonly serialize?: ReadSerializer;
  runRouteSpan(
    operation: "list" | "detail",
    route: string,
    run: () => Promise<void>,
  ): Promise<void>;
}

type ReadHandler = (req: Request, res: Response) => Promise<void>;

/** Low-cardinality span outcome for one failed generated read. */
export function readRouteOutcome(
  error: unknown,
): "not_found" | "rejected" | "failed" {
  const { statusCode } = classifyDatabaseError(error, "read");
  if (statusCode === 404) return "not_found";
  return statusCode < 500 ? "rejected" : "failed";
}

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
  deps: ReadRouteDeps,
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
 * Row data is never cacheable by a shared proxy or a browser: the same URL can
 * answer differently once the underlying table or the caller's rights change.
 */
function writeJson(res: Response, status: number, payload: string): void {
  res.status(status);
  res.type("application/json");
  res.setHeader("Cache-Control", "no-store");
  res.send(payload);
}

/** Measure the encoded body before sending so no partial response escapes. */
function sendJson(res: Response, body: JsonValue): void {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload, "utf8") > MAX_RESPONSE_BYTES) {
    throw new DatabasePluginError("PAYLOAD_TOO_LARGE", "read");
  }
  writeJson(res, 200, payload);
}

/** Answer with the failure's safe category and the field it concerns. */
function writeError(res: Response, error: unknown): void {
  if (res.headersSent) return;
  const safe = classifyDatabaseError(error, "read");
  const body: { error: string; details?: readonly DatabaseErrorDetail[] } = {
    error: safe.clientMessage,
  };
  if (safe.details && safe.details.length > 0) body.details = safe.details;
  writeJson(res, safe.statusCode, JSON.stringify(body));
}

/** `GET /:table` — one bounded page in the `{ items, limit, offset }` envelope. */
export function createListHandler(deps: ReadRouteDeps): ReadHandler {
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
        sendJson(res, {
          items: rows.map((row) => serializeRow(deps, "list", row)),
          limit: decoded.limit,
          offset: decoded.offset,
        });
      });
    } catch (error) {
      writeError(res, error);
    }
  };
}

/** `GET /:table/:id` — one public row, or 404 when nothing matches. */
export function createDetailHandler(deps: ReadRouteDeps): ReadHandler {
  const route = `/${deps.table.name}/:id`;

  return async (req, res) => {
    try {
      await deps.runRouteSpan("detail", route, async () => {
        const id = deps.table.decodeId(req.params.id);
        const decoded = decodeDetailQuery(deps.table, rawQuery(req));
        let query = deps.entity();
        if (decoded.select) query = query.select(decoded.select);
        if (decoded.include) query = query.include(decoded.include);

        const row = await query.find(id);
        if (row === null) throw new DatabasePluginError("NOT_FOUND", "read");
        sendJson(res, serializeRow(deps, "detail", row));
      });
    } catch (error) {
      writeError(res, error);
    }
  };
}

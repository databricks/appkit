import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { context, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

import type { DataPath, Row } from "../../../database/runtime";

/** Values no response, log, or span may ever carry. */
export const SENTINEL = {
  token: "token-sentinel-7f3a",
  actorId: "actor-sentinel-1001",
  email: "sentinel.person@example.com",
  input: "input-sentinel-41",
  row: "row-sentinel-secret",
  privateColumn: "private-column-sentinel-5c",
  error: "exception-sentinel-boom",
  reason: "reason-sentinel-denied",
};

type Store = Record<string, Row[]>;

export const stringify = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );

/**
 * A FAKE of the external database edge, not PostgreSQL: an in-memory DataPath
 * over `tables`. A transaction works on a private copy of every table and
 * replaces the committed rows only when its callback resolves, so commit and
 * rollback are observable; there is no isolation between concurrent
 * transactions and no constraint checking. Each call opens the span a pg
 * instrumentation would, with the SQL text, the row values, and the raw
 * driver exception on it. Inserting the value `"explode"`, or any row into a
 * table passed to `refuseInserts`, fails like a constraint violation.
 */
export function memoryDatabase(tables: readonly string[]) {
  const committed: Store = Object.fromEntries(tables.map((name) => [name, []]));
  const log: string[] = [];
  const refused = new Set<string>();
  let nextId = 1;
  const lower = <T>(statement: string, run: () => T): T => {
    const span = trace
      .getTracer("@opentelemetry/instrumentation-pg")
      .startSpan("pg.query", { attributes: { "db.statement": statement } });
    try {
      return run();
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  };
  const build = (store: Store): DataPath => ({
    select: async (table) => store[table.$name].slice(),
    findOne: async (table, value) =>
      lower(`select * from ${table.$name} where id = ${String(value)}`, () => {
        const row = store[table.$name].find((entry) => entry.id === value);
        return row ? { ...row } : null;
      }),
    count: async (table) => store[table.$name].length,
    insert: async (table, values) =>
      lower(`insert ${stringify(values)}`, () => {
        if (
          refused.has(table.$name) ||
          Object.values(values).includes("explode")
        ) {
          throw new Error(`duplicate key value ${SENTINEL.error}`);
        }
        const row = { id: nextId++, ...values };
        store[table.$name].push(row);
        log.push(`insert:${table.$name}`);
        return { ...row };
      }),
    update: async (table, value, values) =>
      lower(`update ${stringify(values)}`, () => {
        const row = store[table.$name].find((entry) => entry.id === value);
        if (!row) return null;
        Object.assign(row, values);
        return { ...row };
      }),
    upsert: async () => {
      throw new Error("not used");
    },
    delete: async (table, value) => {
      const index = store[table.$name].findIndex((row) => row.id === value);
      if (index === -1) return false;
      store[table.$name].splice(index, 1);
      return true;
    },
    raw: async () => [],
    transaction: async (callback) => {
      log.push("begin");
      const staged: Store = Object.fromEntries(
        Object.entries(store).map(([name, rows]) => [
          name,
          rows.map((row) => ({ ...row })),
        ]),
      );
      try {
        const result = await callback(build(staged));
        for (const name of Object.keys(store)) store[name] = staged[name];
        log.push("commit");
        return result;
      } catch (error) {
        log.push("rollback");
        throw error;
      }
    },
  });
  return {
    path: build(committed),
    committed,
    log,
    refuseInserts: (table: string) => void refused.add(table),
  };
}

/** The external identity edge: a workspace that answers SCIM `Me` per bearer token. */
export async function startWorkspace() {
  const users: Record<string, object> = {
    [`Bearer ${SENTINEL.token}`]: {
      id: SENTINEL.actorId,
      userName: SENTINEL.email,
      active: true,
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    },
    "Bearer token-bob": { id: "bob-2002", userName: "bob@example.com" },
    "Bearer token-sp": {
      id: "sp-3003",
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal"],
    },
  };
  const authorizations: string[] = [];
  const server = http.createServer((req, res) => {
    const authorization = req.headers.authorization ?? "";
    authorizations.push(authorization);
    req.resume();
    if (req.method !== "GET" || req.url !== "/api/2.0/preview/scim/v2/Me") {
      res.writeHead(404).end();
      return;
    }
    const user = users[authorization];
    const status =
      authorization === "Bearer token-outage" ? 500 : user ? 200 : 401;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        user ?? { error_code: "UNAUTHENTICATED", message: "Bad token" },
      ),
    );
  });
  const url = await listen(server);
  return { url, authorizations, close: () => close(server) };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Raw HTTP, so tests control Host, Origin, fetch metadata, and the request
 * target exactly. `absoluteForm` sends the whole URL as the target, as a
 * client talking to a proxy does. The harness's own client is untraced: in
 * production the browser is the client.
 */
export function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    absoluteForm?: boolean;
  },
): Promise<Reply> {
  const headers = { ...options.headers };
  if (options.body !== undefined) {
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }
  return context.with(
    suppressTracing(context.active()),
    () =>
      new Promise<Reply>((resolve, reject) => {
        const target = new URL(url);
        const req = http.request(
          {
            host: target.hostname,
            port: target.port,
            path: options.absoluteForm
              ? target.href
              : target.pathname + target.search,
            method: options.method ?? "GET",
            headers,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(options.body);
      }),
  );
}

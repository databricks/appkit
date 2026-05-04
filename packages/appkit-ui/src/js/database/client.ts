import { DatabaseHTTPError } from "./errors";
import type {
  ApplyIncludes,
  ColumnInfo,
  DatabaseClient,
  DatabaseClientConfig,
  EntityClient,
  IncludeInput,
  OrderInput,
  WhereInput,
} from "./types";
import {
  buildUrl,
  EMPTY_STATE,
  pushFilter,
  pushInclude,
  pushOrder,
  pushSelect,
  type RequestState,
} from "./url-builder";

/**
 * Browser `DatabaseClient`: `Proxy` over `<baseUrl>/<entity>` chains that end in `fetch`.
 *
 * @example
 * ```ts
 * const db = createDatabaseClient();
 * const admins = await db.user
 *   .where({ role: "admin" })
 *   .order({ createdAt: "desc" })
 *   .limit(20)
 *   .toArray();
 * ```
 */
export function createDatabaseClient(
  config: DatabaseClientConfig = {},
): DatabaseClient {
  const fetchImpl: typeof fetch = config.fetch ?? ((...args) => fetch(...args));
  const baseUrl = normalizeBaseUrl(config.baseUrl ?? "/api/database");

  const makeChain = <TRow, TInsert, TUpdate, TIncludes>(
    entity: string,
    state: RequestState,
  ): EntityClient<TRow, TInsert, TUpdate, TIncludes> => {
    const chain: EntityClient<TRow, TInsert, TUpdate, TIncludes> = {
      where: (input: WhereInput<TRow>) =>
        makeChain<TRow, TInsert, TUpdate, TIncludes>(
          entity,
          pushFilter(state, input),
        ),
      order: (input: OrderInput<TRow>) =>
        makeChain<TRow, TInsert, TUpdate, TIncludes>(
          entity,
          pushOrder(state, input),
        ),
      limit: (n: number) =>
        makeChain<TRow, TInsert, TUpdate, TIncludes>(entity, {
          ...state,
          limit: n,
        }),
      offset: (n: number) =>
        makeChain<TRow, TInsert, TUpdate, TIncludes>(entity, {
          ...state,
          offset: n,
        }),
      select: <K extends keyof TRow>(...cols: K[]) =>
        makeChain<Pick<TRow, K>, TInsert, TUpdate, TIncludes>(
          entity,
          pushSelect(state, cols.map(String)),
        ),
      include: <I extends IncludeInput<TIncludes>>(input: I) =>
        makeChain<
          TRow & ApplyIncludes<TIncludes, I>,
          TInsert,
          TUpdate,
          TIncludes
        >(entity, pushInclude(state, input as never)),

      toArray: async (signal) => {
        const res = await fetchImpl(buildUrl(baseUrl, entity, state), {
          signal,
        });
        return readJson<TRow[]>(res);
      },
      first: async (signal) => {
        const rows = await makeChain<TRow, TInsert, TUpdate, TIncludes>(
          entity,
          { ...state, limit: 1 },
        ).toArray(signal);
        return rows[0] ?? null;
      },
      find: async (id, signal) => {
        const url = `${baseUrl}/${entity}/${encodeURIComponent(String(id))}`;
        const res = await fetchImpl(url, { signal });
        if (res.status === 404 || res.status === 204) return null;
        return readJson<TRow>(res);
      },
      count: async (signal) => {
        const countState: RequestState = {
          ...state,
          order: undefined,
          limit: undefined,
          offset: undefined,
          select: undefined,
          include: undefined,
        };
        const url = buildUrl(baseUrl, entity, countState, "count");
        const res = await fetchImpl(url, { signal });
        const json = await readJson<{ count: number }>(res);
        return json.count;
      },
      columns: async (signal) => {
        // Metadata-only endpoint — chain state (where/order/limit/...)
        // would be meaningless here, so we deliberately ignore it.
        const url = `${baseUrl}/${entity}/_columns`;
        const res = await fetchImpl(url, { signal });
        return readJson<ColumnInfo[]>(res);
      },

      create: async (data, signal) => {
        const res = await fetchImpl(`${baseUrl}/${entity}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          signal,
        });
        return readJson<TRow>(res);
      },
      update: async (id, patch, signal) => {
        const url = `${baseUrl}/${entity}/${encodeURIComponent(String(id))}`;
        const res = await fetchImpl(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
          signal,
        });
        // 404 → null like `find()` so callers distinguish missing rows from bad responses.
        if (res.status === 404) return null;
        return readJson<TRow>(res);
      },
      upsert: async (data, options, signal) => {
        const conflictCol = encodeURIComponent(String(options.onConflict));
        const url = `${baseUrl}/${entity}?on_conflict=${conflictCol}`;
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify(data),
          signal,
        });
        return readJson<TRow>(res);
      },
      delete: async (id, signal) => {
        const url = `${baseUrl}/${entity}/${encodeURIComponent(String(id))}`;
        const res = await fetchImpl(url, { method: "DELETE", signal });
        if (!res.ok) throw await buildError(res);
      },
    };

    return chain;
  };

  return new Proxy({} as DatabaseClient, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return makeChain(prop, EMPTY_STATE);
    },
  });
}

let defaultClient: DatabaseClient | undefined;

/** Lazy singleton default client (`/api/database`) — avoids work when `db` isn't imported. */
export const db: DatabaseClient = new Proxy({} as DatabaseClient, {
  get(_target, prop) {
    defaultClient ??= createDatabaseClient();
    return Reflect.get(defaultClient as object, prop);
  },
});

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await buildError(res);
  if (res.status === 204) return undefined as T;
  // Empty body → typed error (JSON.parse("") throws SyntaxError, not DatabaseHTTPError).
  const text = await res.text();
  if (text === "") {
    throw new DatabaseHTTPError(
      res.status,
      "Server returned an empty response body",
      undefined,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new DatabaseHTTPError(
      res.status,
      `Server returned non-JSON response: ${(err as Error).message}`,
      text,
    );
  }
}

async function buildError(res: Response): Promise<DatabaseHTTPError> {
  const body = await safeParseBody(res);
  const message =
    extractMessage(body) ?? res.statusText ?? `HTTP ${res.status}`;
  return new DatabaseHTTPError(res.status, message, body);
}

async function safeParseBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const maybe = body as { error?: unknown; message?: unknown };
  if (typeof maybe.error === "string") return maybe.error;
  if (typeof maybe.message === "string") return maybe.message;
  return undefined;
}

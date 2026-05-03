import type { OrderInput, WhereInput } from "./types";

/**
 * Internal request descriptor accumulated by chain methods on `EntityClient`.
 * Each field holds the pre-serialized AppKit route literal — `buildUrl` just
 * concatenates them into a `URLSearchParams` string.
 */
export interface RequestState {
  filters: Array<{ col: string; expr: string }>;
  order?: string;
  limit?: number;
  offset?: number;
  /** Comma-separated column projection (e.g. `"id,email"`). */
  select?: string;
  /** Include spec (e.g. `"posts(id,title),author"`) — separate from select. */
  include?: string;
}

/** Fresh empty state — used when a new chain is started from `db.<entity>`. */
export const EMPTY_STATE: RequestState = Object.freeze({
  filters: [] as RequestState["filters"],
}) as RequestState;

/**
 * Apply a `.where(...)` input to the state. Bare values become `eq.<value>`;
 * operator objects expand to one filter per op (`role=in.(admin,owner)`).
 */
export function pushFilter<TRow>(
  state: RequestState,
  input: WhereInput<TRow>,
): RequestState {
  const next: RequestState = {
    ...state,
    filters: [...state.filters],
  };
  for (const [col, value] of Object.entries(input)) {
    if (value === null || typeof value !== "object") {
      next.filters.push({ col, expr: `eq.${encodeScalar(value)}` });
      continue;
    }
    if (Array.isArray(value)) {
      next.filters.push({ col, expr: `in.${encodeList(value)}` });
      continue;
    }
    for (const [op, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined) continue;
      next.filters.push({ col, expr: `${op}.${encodeOperand(op, raw)}` });
    }
  }
  return next;
}

/** Merge an `.order(...)` input into the state, preserving prior directives. */
export function pushOrder<TRow>(
  state: RequestState,
  input: OrderInput<TRow>,
): RequestState {
  const parts = Object.entries(input).map(
    ([col, dir]) => `${col}.${dir ?? "asc"}`,
  );
  if (parts.length === 0) return state;
  const next = state.order
    ? `${state.order},${parts.join(",")}`
    : parts.join(",");
  return { ...state, order: next };
}

/** Merge a typed `.select(...)` projection into the state. */
export function pushSelect(
  state: RequestState,
  cols: readonly string[],
): RequestState {
  if (cols.length === 0) return state;
  return { ...state, select: cols.join(",") };
}

/**
 * Serialize an `.include({ posts: true, author: { select: ["id"] } })` input
 * into the route layer's `?include=` syntax. Bare `true` keeps the relation
 * with all default columns; an options bag with `select` projects them.
 *
 * Stored separately from `select` so column projection and relation embedding
 * stay independent and the server can parse each axis cleanly.
 */
export function pushInclude(
  state: RequestState,
  input: Record<
    string,
    | true
    | {
        select?: readonly string[];
      }
  >,
): RequestState {
  const parts: string[] = [];
  for (const [rel, spec] of Object.entries(input)) {
    if (spec === undefined) continue;
    if (spec === true) {
      parts.push(rel);
      continue;
    }
    if (spec.select?.length) {
      parts.push(`${rel}(${spec.select.join(",")})`);
    } else {
      parts.push(rel);
    }
  }
  if (parts.length === 0) return state;
  const next = state.include
    ? `${state.include},${parts.join(",")}`
    : parts.join(",");
  return { ...state, include: next };
}

/** Compose the final URL for this entity/state. */
export function buildUrl(
  baseUrl: string,
  entity: string,
  state: RequestState,
): string {
  const params = new URLSearchParams();
  for (const f of state.filters) params.append(f.col, f.expr);
  if (state.order) params.set("order", state.order);
  if (state.limit !== undefined) params.set("limit", String(state.limit));
  if (state.offset !== undefined) params.set("offset", String(state.offset));
  if (state.select) params.set("select", state.select);
  if (state.include) params.set("include", state.include);
  const qs = params.toString();
  return `${baseUrl}/${entity}${qs ? `?${qs}` : ""}`;
}

function encodeOperand(op: string, value: unknown): string {
  if (op === "in") return encodeList(value as unknown[]);
  if (value === null) return "null";
  return encodeScalar(value);
}

function encodeList(values: unknown[]): string {
  return `(${values.map(encodeScalar).join(",")})`;
}

function encodeScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" && /[,()"\s]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

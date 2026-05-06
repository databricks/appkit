import type { OrderInput, WhereInput } from "./types";

/**
 * Accumulated query state for `EntityClient` chains — fields are literal strings
 * that `buildUrl` joins into `URLSearchParams`.
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

/**
 * Starting state for `db.<entity>` — frozen so callers can't mutate the shared empty filters.
 */
export const EMPTY_STATE: RequestState = Object.freeze({
  filters: Object.freeze([]) as unknown as RequestState["filters"],
}) as RequestState;

// Mirror route allowlist — runtime JSON can bypass TS.
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

// Cap `in` size — long URLs hit proxy/browser limits (414 / truncation).
const MAX_IN_LIST = 100;

/**
 * Merge `.where(...)`: scalars → `eq`; objects expand ops; bare `null` → `is.null`.
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
    if (value === null) {
      next.filters.push({ col, expr: "is.null" });
      continue;
    }
    if (typeof value !== "object") {
      next.filters.push({ col, expr: `eq.${encodeScalar(value)}` });
      continue;
    }
    if (Array.isArray(value)) {
      assertInListSize(value, col);
      next.filters.push({ col, expr: `in.${encodeList(value)}` });
      continue;
    }
    for (const [op, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined) continue;
      if (!ALLOWED_OPS.has(op)) {
        throw new Error(
          `Unsupported where operator "${op}" on column "${col}"`,
        );
      }
      if (op === "in" && Array.isArray(raw)) assertInListSize(raw, col);
      next.filters.push({ col, expr: `${op}.${encodeOperand(op, raw)}` });
    }
  }
  return next;
}

function assertInListSize(values: readonly unknown[], col: string): void {
  if (values.length > MAX_IN_LIST) {
    throw new Error(
      `where(${col}.in) accepts at most ${MAX_IN_LIST} values; got ${values.length}. ` +
        `Page the parent query or batch the IN list.`,
    );
  }
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
 * Serialize `.include(...)` to `?include=` — independent of column `select`.
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

/**
 * Final URL for `entity` + `state`. Optional `subpath` (e.g. `count`) is allowlisted
 * so dynamic entity keys can't escape the mount.
 */
export function buildUrl(
  baseUrl: string,
  entity: string,
  state: RequestState,
  subpath?: string,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entity)) {
    throw new Error(
      `Invalid entity name "${entity}". Must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
  if (subpath !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(subpath)) {
    throw new Error(`Invalid subpath "${subpath}".`);
  }
  const params = new URLSearchParams();
  for (const f of state.filters) params.append(f.col, f.expr);
  if (state.order) params.set("order", state.order);
  if (state.limit !== undefined) params.set("limit", String(state.limit));
  if (state.offset !== undefined) params.set("offset", String(state.offset));
  if (state.select) params.set("select", state.select);
  if (state.include) params.set("include", state.include);
  const qs = params.toString();
  const tail = subpath ? `/${encodeURIComponent(subpath)}` : "";
  return `${baseUrl}/${encodeURIComponent(entity)}${tail}${qs ? `?${qs}` : ""}`;
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

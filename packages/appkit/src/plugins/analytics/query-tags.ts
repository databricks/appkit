import type express from "express";

import { createLogger } from "../../logging/logger";
import type { QueryTag } from "../../workspace-client";
import type { QueryExecutor } from "./result-delivery";
import type { IAnalyticsConfig } from "./types";

const logger = createLogger("analytics:query-tags");

/**
 * Query tags as a key → value map. A `null` value records a key-only tag.
 * Tags land in `system.query.history.query_tags` as plain text — never put
 * secrets or PII in them.
 */
export type QueryTagMap = Record<string, string | null>;

/** Entry point that issued the statement, recorded as `appkit_route`. */
export type QueryTagsRoute = "query" | "metric" | "agent_tool";

/** Context handed to a function-form `queryTags` config. */
export interface QueryTagsContext {
  route: QueryTagsRoute;
  /** Query key (`/query`) or metric key (`/metric`); absent for agent tools. */
  queryKey?: string;
  /** `"obo"` when the statement runs on behalf of the user, else `"sp"`. */
  lane: "sp" | "obo";
  /** Incoming request; absent for agent tool calls. */
  req?: express.Request;
  /**
   * Validated tags sent by the client in the request body. They are only
   * forwarded if the function returns them.
   */
  clientTags: QueryTagMap;
}

type QueryTagsConfig = Pick<
  IAnalyticsConfig,
  "queryTags" | "autoQueryTags" | "clientQueryTags"
>;

/** Hard cap the warehouse applies; anything past it is dropped server-side. */
export const MAX_QUERY_TAGS = 20;
const MAX_TAG_LENGTH = 128;
/**
 * Upper bound on client entries examined per request, so a huge `queryTags`
 * body can't buy unbounded work when at most 20 tags are ever sent.
 */
const MAX_CLIENT_CANDIDATES = 64;
/** Prefix reserved for AppKit's automatic tags (matched case-insensitively). */
const RESERVED_PREFIX = "appkit_";
/** Characters the warehouse rejects in tag keys, plus control characters. */
const INVALID_KEY_CHARS = /[,:\-/=.\p{Cc}]/u;

/**
 * Tags in priority order. A `Map` keeps insertion order for every key —
 * a plain object would enumerate integer-like keys (`"0"`, `"1"`) first and
 * treat `__proto__` as the prototype setter.
 */
type TagEntries = Map<string, string | null>;

function isValidKey(key: string): boolean {
  return (
    key.length > 0 &&
    key === key.trim() &&
    key.length <= MAX_TAG_LENGTH &&
    !INVALID_KEY_CHARS.test(key) &&
    !key.startsWith("@@") &&
    !key.toLowerCase().startsWith(RESERVED_PREFIX)
  );
}

/** Truncate by code point so a surrogate pair is never split. */
function truncate(value: string): string {
  return value.length <= MAX_TAG_LENGTH
    ? value
    : Array.from(value).slice(0, MAX_TAG_LENGTH).join("");
}

/**
 * Keep only well-formed, non-reserved tags. Invalid entries are dropped rather
 * than failing the query: a bad tag must never break a dashboard. Values are
 * truncated to the warehouse's 128-character limit.
 */
export function sanitizeQueryTags(
  input: unknown,
  source: "client" | "config",
): TagEntries {
  const out: TagEntries = new Map();
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return out;
  }
  let examined = 0;
  let dropped = 0;
  for (const key in input) {
    if (!Object.hasOwn(input, key)) continue;
    if (source === "client" && ++examined > MAX_CLIENT_CANDIDATES) {
      dropped++;
      break;
    }
    const value = (input as Record<string, unknown>)[key];
    if (!isValidKey(key) || (value !== null && typeof value !== "string")) {
      dropped++;
      continue;
    }
    out.set(key, value === null ? null : truncate(value));
  }
  if (dropped > 0) {
    // Only the count is logged: key names are untrusted and could forge log
    // lines. Client input may be noisy; config mistakes are the developer's.
    if (source === "config") {
      logger.warn("Dropped %d invalid config query tag(s)", dropped);
    } else {
      logger.debug("Dropped %d invalid client query tag(s)", dropped);
    }
  }
  return out;
}

function autoTags(
  ctx: Pick<QueryTagsContext, "route" | "queryKey" | "lane">,
): TagEntries {
  const tags: TagEntries = new Map();
  const appName = process.env.DATABRICKS_APP_NAME;
  if (appName) tags.set("appkit_app", truncate(appName));
  if (ctx.queryKey) tags.set("appkit_query_key", truncate(ctx.queryKey));
  tags.set("appkit_route", ctx.route);
  tags.set("appkit_lane", ctx.lane);
  return tags;
}

/** Static maps are sanitized (and warned about) once, not per statement. */
const staticTagsCache = new WeakMap<object, TagEntries>();

function staticConfigTags(queryTags: QueryTagMap): TagEntries {
  let tags = staticTagsCache.get(queryTags);
  if (!tags) {
    tags = sanitizeQueryTags(queryTags, "config");
    staticTagsCache.set(queryTags, tags);
  }
  return tags;
}

function functionConfigTags(
  queryTags: (ctx: QueryTagsContext) => QueryTagMap | undefined,
  ctx: QueryTagsContext,
): TagEntries {
  try {
    return sanitizeQueryTags(queryTags(ctx), "config");
  } catch (err) {
    logger.warn(
      "queryTags callback threw; continuing without custom tags: %s",
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}

/**
 * Resolve the tags for one statement.
 *
 * Automatic `appkit_*` tags come first and can't be overridden. Then:
 * - static `queryTags` map: config tags, then client tags (config wins on
 *   collisions);
 * - function `queryTags`: its return value is the whole custom set. Client
 *   tags are only sent if it returns them, e.g. `{ ...ctx.clientTags }`.
 *
 * The result is capped at {@link MAX_QUERY_TAGS} in that priority order, so
 * the automatic tags always fit.
 */
export function resolveQueryTags(
  config: QueryTagsConfig,
  ctx: Omit<QueryTagsContext, "clientTags"> & { clientTags?: unknown },
): QueryTag[] | undefined {
  const clientTags: TagEntries =
    config.clientQueryTags === false
      ? new Map()
      : sanitizeQueryTags(ctx.clientTags, "client");

  const merged: TagEntries =
    config.autoQueryTags === false ? new Map() : autoTags(ctx);
  const { queryTags } = config;
  const sources: TagEntries[] =
    typeof queryTags === "function"
      ? [
          functionConfigTags(queryTags, {
            ...ctx,
            clientTags: Object.fromEntries(clientTags),
          }),
        ]
      : [queryTags ? staticConfigTags(queryTags) : new Map(), clientTags];
  for (const tags of sources) {
    for (const [key, value] of tags) {
      if (!merged.has(key)) merged.set(key, value);
    }
  }

  const result: QueryTag[] = [];
  for (const [key, value] of merged) {
    if (result.length === MAX_QUERY_TAGS) break;
    result.push(value === null ? { key } : { key, value });
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Wrap an executor so every statement it issues carries `queryTags`. Tags are
 * not part of any cache key: a cache hit never reaches the warehouse, and
 * concurrent identical requests share one in-flight statement tagged by the
 * first caller.
 */
export function withQueryTags(
  executor: QueryExecutor,
  queryTags: QueryTag[] | undefined,
): QueryExecutor {
  if (!queryTags) return executor;
  return {
    query: (query, parameters, formatParameters, signal) =>
      executor.query(
        query,
        parameters,
        { ...formatParameters, queryTags },
        signal,
      ),
  };
}

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
  /** Sanitized tags sent by the client in the request body. */
  clientTags: QueryTagMap;
}

type QueryTagsConfig = Pick<
  IAnalyticsConfig,
  "queryTags" | "autoQueryTags" | "clientQueryTags"
>;

/** Hard cap the warehouse applies; anything past it is dropped server-side. */
export const MAX_QUERY_TAGS = 20;
const MAX_TAG_LENGTH = 128;
/** Prefix reserved for AppKit's automatic tags. */
const RESERVED_PREFIX = "appkit_";
/** Characters the warehouse rejects in tag keys. */
const INVALID_KEY_CHARS = /[,:\-/=.]/;

function isValidKey(key: string): boolean {
  return (
    key.trim().length > 0 &&
    key.length <= MAX_TAG_LENGTH &&
    !INVALID_KEY_CHARS.test(key) &&
    !key.startsWith("@@")
  );
}

/**
 * Keep only well-formed, non-reserved tags. Invalid entries are dropped rather
 * than failing the query: a bad tag must never break a dashboard. Values are
 * truncated to the warehouse's 128-character limit.
 */
export function sanitizeQueryTags(
  input: unknown,
  source: "client" | "config",
): QueryTagMap {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: QueryTagMap = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (
      !isValidKey(key) ||
      key.startsWith(RESERVED_PREFIX) ||
      (value !== null && typeof value !== "string")
    ) {
      dropped.push(key);
      continue;
    }
    out[key] = value === null ? null : value.slice(0, MAX_TAG_LENGTH);
  }
  if (dropped.length > 0) {
    const message = "Dropped %d invalid %s query tag(s): %s";
    const keys = dropped.slice(0, 5).join(", ").slice(0, 200);
    // Client input is untrusted and may be noisy; config mistakes are the
    // developer's to fix.
    if (source === "config") {
      logger.warn(message, dropped.length, source, keys);
    } else {
      logger.debug(message, dropped.length, source, keys);
    }
  }
  return out;
}

function autoTags(ctx: QueryTagsContext): QueryTagMap {
  const tags: QueryTagMap = {};
  const appName = process.env.DATABRICKS_APP_NAME;
  if (appName) tags.appkit_app = appName.slice(0, MAX_TAG_LENGTH);
  if (ctx.queryKey) {
    tags.appkit_query_key = ctx.queryKey.slice(0, MAX_TAG_LENGTH);
  }
  tags.appkit_route = ctx.route;
  tags.appkit_lane = ctx.lane;
  return tags;
}

function configTags(
  config: QueryTagsConfig,
  ctx: QueryTagsContext,
): QueryTagMap {
  const { queryTags } = config;
  if (queryTags === undefined) return {};
  if (typeof queryTags !== "function") {
    return sanitizeQueryTags(queryTags, "config");
  }
  try {
    return sanitizeQueryTags(queryTags(ctx), "config");
  } catch (err) {
    logger.warn(
      "queryTags callback threw; continuing without custom tags: %s",
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}

/**
 * Resolve the tags for one statement.
 *
 * Precedence on key collisions: automatic `appkit_*` tags (reserved, cannot
 * be overridden) > server `queryTags` config > client-sent tags. Tags are
 * then capped at {@link MAX_QUERY_TAGS} in the same priority order, so the
 * automatic tags always fit.
 */
export function resolveQueryTags(
  config: QueryTagsConfig,
  ctx: Omit<QueryTagsContext, "clientTags"> & { clientTags?: unknown },
): QueryTag[] | undefined {
  const clientTags =
    config.clientQueryTags === false
      ? {}
      : sanitizeQueryTags(ctx.clientTags, "client");
  const fullCtx: QueryTagsContext = { ...ctx, clientTags };

  const merged: QueryTagMap = {
    ...(config.autoQueryTags === false ? {} : autoTags(fullCtx)),
  };
  for (const tags of [configTags(config, fullCtx), clientTags]) {
    for (const [key, value] of Object.entries(tags)) {
      if (!Object.hasOwn(merged, key)) merged[key] = value;
    }
  }

  const entries = Object.entries(merged).slice(0, MAX_QUERY_TAGS);
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) =>
    value === null ? { key } : { key, value },
  );
}

/**
 * Wrap an executor so every statement it issues carries `queryTags`. Tags are
 * not part of any cache key: a cache hit never reaches the warehouse, so there
 * is nothing to attribute.
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

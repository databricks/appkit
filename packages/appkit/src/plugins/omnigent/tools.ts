import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerSpec } from "./bundle";

/**
 * A Databricks-managed MCP server the app's sessions can call. Calls run as
 * the session's user, so Unity Catalog permissions apply.
 */
export type OmnigentToolSource =
  /** Databricks SQL: run SQL statements on a warehouse. */
  | { type: "sql"; name?: string }
  /** One Genie space. */
  | { type: "genie"; spaceId: string; name?: string }
  /** Unity Catalog functions in a schema, or one function. */
  | {
      type: "functions";
      catalog: string;
      schema: string;
      function?: string;
      name?: string;
    }
  /** AI Search over an index, or every index in a schema. */
  | {
      type: "ai-search";
      catalog: string;
      schema: string;
      index?: string;
      name?: string;
    }
  /** A Unity Gateway MCP Service, e.g. `system.ai.web_search` or `main.tools.jira`. */
  | { type: "service"; service: string; name?: string };

/** Tools that change data by default: `ask` pauses on them and `read` denies them. */
const DEFAULT_WRITE_TOOLS: Partial<
  Record<OmnigentToolSource["type"], string[]>
> = {
  sql: ["execute_sql"],
};

const PROXY = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "python",
    "mcp_proxy.py",
  ),
  "utf8",
);

function urlPath(source: OmnigentToolSource): string {
  const seg = encodeURIComponent;
  switch (source.type) {
    case "sql":
      return "/api/2.0/mcp/sql";
    case "genie":
      return `/api/2.0/mcp/genie/${seg(source.spaceId)}`;
    case "functions":
      return `/api/2.0/mcp/functions/${seg(source.catalog)}/${seg(source.schema)}${source.function ? `/${seg(source.function)}` : ""}`;
    case "ai-search":
      return `/api/2.0/mcp/ai-search/${seg(source.catalog)}/${seg(source.schema)}${source.index ? `/${seg(source.index)}` : ""}`;
    case "service":
      return `/ai-gateway/mcp-services/${seg(source.service)}`;
  }
}

function defaultName(source: OmnigentToolSource): string {
  switch (source.type) {
    case "sql":
      return "sql";
    case "genie":
      return `genie_${source.spaceId.slice(-8)}`;
    case "functions":
      return `functions_${source.schema}${source.function ? `_${source.function}` : ""}`;
    case "ai-search":
      return `search_${source.index ?? source.schema}`;
    case "service":
      // The full name: a bare service name can collide with an Omnigent built-in tool (`web_search`).
      return source.service.replace(/\./g, "_");
  }
}

/**
 * The bundle entry for a tool source: a stdio MCP server that runs inside the
 * session's Sandbox and forwards to the managed MCP URL as the session's user.
 * (A Sandbox's credential is not attached to HTTP MCP servers.)
 */
export function toolServer(
  source: OmnigentToolSource,
  workspaceHost: string,
): McpServerSpec {
  const name = (source.name ?? defaultName(source))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return {
    name,
    description: `Databricks ${source.type} tools, run as the signed-in user`,
    transport: "stdio",
    command: "python3",
    args: ["-c", PROXY, `${workspaceHost}${urlPath(source)}`],
  };
}

/** Tool names that change data across the sources, plus any the app lists. */
export function writeToolNames(
  sources: OmnigentToolSource[],
  extra: string[] = [],
): string[] {
  return [
    ...new Set([
      ...sources.flatMap((s) => DEFAULT_WRITE_TOOLS[s.type] ?? []),
      ...extra,
    ]),
  ];
}

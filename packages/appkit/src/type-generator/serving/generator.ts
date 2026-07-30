import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import pc from "picocolors";
import { createLogger } from "../../logging/logger";
import type { EndpointConfig } from "../../plugins/serving/types";
import { renderCacheHeader, resolveHeaderTimestamp } from "../embedded-cache";
import {
  migrateProjectConfig,
  removeOldGeneratedTypes,
  resolveProjectRoot,
} from "../migration";
import {
  CACHE_VERSION,
  endpointIdentityHash,
  loadServingCache,
  type ServingCache,
} from "./cache";
import {
  convertRequestSchema,
  convertResponseSchema,
  deriveChunkType,
} from "./converter";
import { fetchOpenApiSchema } from "./fetcher";
import {
  extractServingEndpoints,
  findServerFile,
} from "./server-file-extractor";

const logger = createLogger("type-generator:serving");

const GENERIC_REQUEST = "Record<string, unknown>";
const GENERIC_RESPONSE = "unknown";
const GENERIC_CHUNK = "unknown";

interface GenerateServingTypesOptions {
  outFile: string;
  endpoints?: Record<string, EndpointConfig>;
  noCache?: boolean;
}

/**
 * Generates TypeScript type declarations for serving endpoints
 * by fetching their OpenAPI schemas and converting to TypeScript.
 *
 * Endpoint discovery order (when `endpoints` is not provided):
 * 1. AST extraction from server file (server/index.ts or server/server.ts)
 * 2. DATABRICKS_SERVING_ENDPOINT_NAME env var (single default endpoint)
 */
export async function generateServingTypes(
  options: GenerateServingTypesOptions,
): Promise<void> {
  const { outFile, noCache } = options;
  const projectRoot = resolveProjectRoot(outFile);

  // Resolve endpoints: explicit > AST extraction from server file > env var fallback
  const endpoints =
    options.endpoints ??
    resolveEndpointsFromServerFile() ??
    resolveDefaultEndpoints();
  if (Object.keys(endpoints).length === 0) {
    logger.debug("No serving endpoints configured, skipping type generation");
    return;
  }

  const startTime = performance.now();

  // Read the committed serving.d.ts once: it's both the cache source and the
  // prior file we diff against to preserve the timestamp on an unchanged run.
  const priorSource = await fs.readFile(outFile, "utf-8").catch(() => "");

  // Reconstruct the serving cache from the committed serving.d.ts (its header
  // identity hashes + body member blocks). Missing/old file → empty.
  const cache: ServingCache = noCache
    ? { version: CACHE_VERSION, endpoints: {} }
    : await loadServingCache(outFile);

  let client: WorkspaceClient | undefined;
  const getClient = (): WorkspaceClient => {
    client ??= new WorkspaceClient({});
    return client;
  };

  const registryEntries: string[] = [];
  const headerEntries: Array<{ name: string; hash: string; detail: string }> =
    [];
  const logEntries: Array<{
    alias: string;
    status: "HIT" | "MISS";
    error?: string;
  }> = [];

  for (const [alias, config] of Object.entries(endpoints)) {
    const result = await processEndpoint(alias, config, cache, getClient);
    registryEntries.push(result.entry);
    if (result.headerEntry) headerEntries.push(result.headerEntry);
    logEntries.push(result.log);
  }

  printLogTable(logEntries, startTime);

  const output = generateTypeDeclarations(
    registryEntries,
    headerEntries,
    priorSource,
  );
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, output, "utf-8");

  // One-time migration: remove old generated file and patch project configs
  await removeOldGeneratedTypes(projectRoot, "appKitServingTypes.d.ts");
  await migrateProjectConfig(projectRoot);

  if (registryEntries.length === 0) {
    logger.debug(
      "Wrote empty serving types to %s (no endpoints resolved)",
      outFile,
    );
  } else {
    logger.debug("Wrote serving types to %s", outFile);
  }
}

interface EndpointResult {
  entry: string;
  log: { alias: string; status: "HIT" | "MISS"; error?: string };
  /**
   * Present only for a fully-resolved endpoint (cache hit or a fresh successful
   * conversion), recording its identity hash in the file header. Omitted for a
   * permissive/generic fallback so it re-reads as a MISS next pass.
   */
  headerEntry?: { name: string; hash: string; detail: string };
}

function genericEntry(alias: string): string {
  return buildRegistryEntry(
    alias,
    GENERIC_REQUEST,
    GENERIC_RESPONSE,
    GENERIC_CHUNK,
  );
}

async function processEndpoint(
  alias: string,
  config: EndpointConfig,
  cache: ServingCache,
  getClient: () => WorkspaceClient,
): Promise<EndpointResult> {
  const endpointName = process.env[config.env];
  if (!endpointName) {
    // No resolved endpoint name → nothing to key on. Emit a generic entry and
    // leave it out of the header so it re-reads as a MISS once configured.
    return {
      entry: genericEntry(alias),
      log: { alias, status: "MISS", error: `env ${config.env} not set` },
    };
  }

  // Local identity hash — computed WITHOUT any network call, so a committed hit
  // skips the fetch entirely.
  const hash = endpointIdentityHash(alias, endpointName);
  const detail = endpointName;

  // Cache hit: reuse the committed member verbatim. No getOpenApi call.
  const cached = cache.endpoints[alias];
  if (cached && cached.hash === hash) {
    return {
      entry: `    ${alias}: ${cached.member};`,
      log: { alias, status: "HIT" },
      headerEntry: { name: alias, hash, detail },
    };
  }

  // Cache miss: fetch the OpenAPI schema and convert it.
  const result = await fetchOpenApiSchema(
    getClient(),
    endpointName,
    config.servedModel,
  );
  if (!result) {
    return {
      entry: genericEntry(alias),
      log: { alias, status: "MISS", error: "schema fetch failed" },
    };
  }

  const { spec, pathKey } = result;

  // Cache miss — convert schema to types
  const operation = spec.paths[pathKey]?.post;
  if (!operation) {
    return {
      entry: genericEntry(alias),
      log: { alias, status: "MISS", error: "no POST operation" },
    };
  }

  try {
    const requestType = convertRequestSchema(operation);
    const responseType = convertResponseSchema(operation);
    const chunkType = deriveChunkType(operation);

    return {
      entry: buildRegistryEntry(alias, requestType, responseType, chunkType),
      log: { alias, status: "MISS" },
      headerEntry: { name: alias, hash, detail },
    };
  } catch (convErr) {
    logger.warn(
      "Schema conversion failed for '%s': %s",
      alias,
      (convErr as Error).message,
    );
    return {
      entry: genericEntry(alias),
      log: { alias, status: "MISS", error: "schema conversion failed" },
    };
  }
}

function printLogTable(
  logEntries: Array<{ alias: string; status: "HIT" | "MISS"; error?: string }>,
  startTime: number,
): void {
  if (logEntries.length === 0) return;

  const maxNameLen = Math.max(...logEntries.map((e) => e.alias.length));
  const separator = pc.dim("─".repeat(50));
  console.log("");
  console.log(
    `  ${pc.bold("Typegen Serving")} ${pc.dim(`(${logEntries.length})`)}`,
  );
  console.log(`  ${separator}`);
  for (const entry of logEntries) {
    const tag =
      entry.status === "HIT"
        ? `cache ${pc.bold(pc.green("HIT  "))}`
        : `cache ${pc.bold(pc.yellow("MISS "))}`;
    const rawName = entry.alias.padEnd(maxNameLen);
    const reason = entry.error ? `  ${pc.dim(entry.error)}` : "";
    console.log(`  ${tag}  ${rawName}${reason}`);
  }
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  const newCount = logEntries.filter((e) => e.status === "MISS").length;
  const cacheCount = logEntries.filter((e) => e.status === "HIT").length;
  console.log(`  ${separator}`);
  console.log(
    `  ${newCount} new, ${cacheCount} from cache. ${pc.dim(`${elapsed}s`)}`,
  );
  console.log("");
}

function resolveEndpointsFromServerFile():
  | Record<string, EndpointConfig>
  | undefined {
  try {
    const serverFile = findServerFile(process.cwd());
    if (!serverFile) return undefined;
    return extractServingEndpoints(serverFile) ?? undefined;
  } catch (error) {
    logger.debug(
      "Failed to extract endpoints from server file: %s",
      (error as Error).message,
    );
    return undefined;
  }
}

function resolveDefaultEndpoints(): Record<string, EndpointConfig> {
  if (process.env.DATABRICKS_SERVING_ENDPOINT_NAME) {
    return { default: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } };
  }
  return {};
}

function buildRegistryEntry(
  alias: string,
  requestType: string,
  responseType: string,
  chunkType: string | null,
): string {
  const indent = "      ";
  const chunkEntry = chunkType ? chunkType : "unknown";
  return `    ${alias}: {
${indent}request: ${indentType(requestType, indent)};
${indent}response: ${indentType(responseType, indent)};
${indent}chunk: ${indentType(chunkEntry, indent)};
    };`;
}

function indentType(typeStr: string, baseIndent: string): string {
  if (!typeStr.includes("\n")) return typeStr;
  return typeStr
    .split("\n")
    .map((line, i) => (i === 0 ? line : `${baseIndent}${line}`))
    .join("\n");
}

function generateTypeDeclarations(
  entries: string[],
  headerEntries: Array<{ name: string; hash: string; detail: string }>,
  priorSource = "",
): string {
  const header = renderCacheHeader({
    version: CACHE_VERSION,
    explainer:
      "A matching endpoint-identity hash skips the serving fetch on build & deploy.",
    entries: headerEntries,
    // Preserve the prior timestamp when the entry set is unchanged → no churn.
    timestamp: resolveHeaderTimestamp(priorSource, headerEntries),
  });
  return `${header}import "@databricks/appkit";
import "@databricks/appkit-ui/react";

declare module "@databricks/appkit" {
  interface ServingEndpointRegistry {
${entries.join("\n")}
  }
}

declare module "@databricks/appkit-ui/react" {
  interface ServingEndpointRegistry {
${entries.join("\n")}
  }
}
`;
}

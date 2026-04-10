import fs from "node:fs/promises";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import pc from "picocolors";
import { createLogger } from "../../logging/logger";
import type { EndpointConfig } from "../../plugins/serving/types";
import {
  CACHE_VERSION,
  hashSchema,
  loadServingCache,
  type ServingCache,
  saveServingCache,
} from "./cache";
import {
  convertRequestSchema,
  convertResponseSchema,
  deriveChunkType,
  extractRequestKeys,
} from "./converter";
import { fetchOpenApiSchema } from "./fetcher";

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
 */
export async function generateServingTypes(
  options: GenerateServingTypesOptions,
): Promise<void> {
  const { outFile, noCache } = options;

  // Resolve endpoints from config or env
  const endpoints = options.endpoints ?? resolveDefaultEndpoints();
  if (Object.keys(endpoints).length === 0) {
    logger.debug("No serving endpoints configured, skipping type generation");
    return;
  }

  const startTime = performance.now();

  const cache = noCache
    ? { version: CACHE_VERSION, endpoints: {} }
    : await loadServingCache();

  let client: WorkspaceClient | undefined;
  let updated = false;

  const registryEntries: string[] = [];
  const logEntries: Array<{
    alias: string;
    status: "HIT" | "MISS";
    error?: string;
  }> = [];

  for (const [alias, config] of Object.entries(endpoints)) {
    client ??= new WorkspaceClient({});
    const result = await processEndpoint(alias, config, client, cache);
    if (result.cacheUpdated) updated = true;
    registryEntries.push(result.entry);
    logEntries.push(result.log);
  }

  printLogTable(logEntries, startTime);

  const output = generateTypeDeclarations(registryEntries);
  await fs.writeFile(outFile, output, "utf-8");

  if (registryEntries.length === 0) {
    logger.debug(
      "Wrote empty serving types to %s (no endpoints resolved)",
      outFile,
    );
  } else {
    logger.debug("Wrote serving types to %s", outFile);
  }

  if (updated) {
    await saveServingCache(cache as ServingCache);
  }
}

interface EndpointResult {
  entry: string;
  log: { alias: string; status: "HIT" | "MISS"; error?: string };
  cacheUpdated: boolean;
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
  client: WorkspaceClient,
  cache: { endpoints: Record<string, any> },
): Promise<EndpointResult> {
  const endpointName = process.env[config.env];
  if (!endpointName) {
    return {
      entry: genericEntry(alias),
      log: { alias, status: "MISS", error: `env ${config.env} not set` },
      cacheUpdated: false,
    };
  }

  const result = await fetchOpenApiSchema(
    client,
    endpointName,
    config.servedModel,
  );
  if (!result) {
    return {
      entry: genericEntry(alias),
      log: { alias, status: "MISS", error: "schema fetch failed" },
      cacheUpdated: false,
    };
  }

  const { spec, pathKey } = result;
  const hash = hashSchema(JSON.stringify(spec));

  // Cache hit
  const cached = cache.endpoints[alias];
  if (cached && cached.hash === hash) {
    return {
      entry: buildRegistryEntry(
        alias,
        cached.requestType,
        cached.responseType,
        cached.chunkType,
      ),
      log: { alias, status: "HIT" },
      cacheUpdated: false,
    };
  }

  // Cache miss — convert schema to types
  const operation = spec.paths[pathKey]?.post;
  if (!operation) {
    return {
      entry: genericEntry(alias),
      log: { alias, status: "MISS", error: "no POST operation" },
      cacheUpdated: false,
    };
  }

  try {
    const requestType = convertRequestSchema(operation);
    const responseType = convertResponseSchema(operation);
    const chunkType = deriveChunkType(operation);
    const requestKeys = extractRequestKeys(operation);

    cache.endpoints[alias] = {
      hash,
      requestType,
      responseType,
      chunkType,
      requestKeys,
    };

    return {
      entry: buildRegistryEntry(alias, requestType, responseType, chunkType),
      log: { alias, status: "MISS" },
      cacheUpdated: true,
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
      cacheUpdated: false,
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

function generateTypeDeclarations(entries: string[]): string {
  return `// Auto-generated by AppKit - DO NOT EDIT
// Generated from serving endpoint OpenAPI schemas
import "@databricks/appkit";
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

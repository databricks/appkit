import fs from "node:fs/promises";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import pc from "picocolors";
import { createLogger } from "../../logging/logger";
import type { EndpointConfig } from "../../plugins/serving/types";
import {
  hashSchema,
  loadServingCache,
  type ServingCache,
  saveServingCache,
} from "./cache";
import {
  convertRequestSchema,
  convertResponseSchema,
  deriveChunkType,
} from "./converter";
import { fetchOpenApiSchema } from "./fetcher";

const logger = createLogger("type-generator:serving");

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
    ? { version: "1", endpoints: {} }
    : await loadServingCache();

  const client = new WorkspaceClient({});
  let updated = false;

  const registryEntries: string[] = [];
  const logEntries: Array<{
    alias: string;
    status: "HIT" | "MISS";
    failed?: boolean;
    error?: string;
  }> = [];

  for (const [alias, config] of Object.entries(endpoints)) {
    const endpointName = process.env[config.env];
    if (!endpointName) {
      logEntries.push({
        alias,
        status: "MISS",
        failed: true,
        error: `env ${config.env} not set`,
      });
      continue;
    }

    const result = await fetchOpenApiSchema(
      client,
      endpointName,
      config.servedModel,
    );
    if (!result) {
      logEntries.push({
        alias,
        status: "MISS",
        failed: true,
        error: "schema fetch failed",
      });
      continue;
    }

    const { spec, pathKey } = result;
    const schemaJson = JSON.stringify(spec);
    const hash = hashSchema(schemaJson);

    // Check cache
    const cached = cache.endpoints[alias];
    if (cached && cached.hash === hash) {
      registryEntries.push(
        buildRegistryEntry(
          alias,
          cached.requestType,
          cached.responseType,
          cached.chunkType,
        ),
      );
      logEntries.push({ alias, status: "HIT" });
      continue;
    }

    // Cache miss — convert
    const operation = spec.paths[pathKey]?.post;
    if (!operation) {
      logEntries.push({
        alias,
        status: "MISS",
        failed: true,
        error: "no POST operation",
      });
      continue;
    }

    const requestType = convertRequestSchema(operation);
    const responseType = convertResponseSchema(operation);
    const chunkType = deriveChunkType(operation);

    cache.endpoints[alias] = { hash, requestType, responseType, chunkType };
    updated = true;

    registryEntries.push(
      buildRegistryEntry(alias, requestType, responseType, chunkType),
    );
    logEntries.push({ alias, status: "MISS" });
  }

  // Print formatted table (matching analytics typegen output)
  if (logEntries.length > 0) {
    const maxNameLen = Math.max(...logEntries.map((e) => e.alias.length));
    const separator = pc.dim("─".repeat(50));
    console.log("");
    console.log(
      `  ${pc.bold("Typegen Serving")} ${pc.dim(`(${logEntries.length})`)}`,
    );
    console.log(`  ${separator}`);
    for (const entry of logEntries) {
      const tag = entry.failed
        ? pc.bold(pc.red("ERROR"))
        : entry.status === "HIT"
          ? `cache ${pc.bold(pc.green("HIT  "))}`
          : `cache ${pc.bold(pc.yellow("MISS "))}`;
      const rawName = entry.alias.padEnd(maxNameLen);
      const name = entry.failed ? pc.dim(pc.strikethrough(rawName)) : rawName;
      const reason = entry.error ? `  ${pc.dim(entry.error)}` : "";
      console.log(`  ${tag}  ${name}${reason}`);
    }
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    const newCount = logEntries.filter(
      (e) => e.status === "MISS" && !e.failed,
    ).length;
    const cacheCount = logEntries.filter(
      (e) => e.status === "HIT" && !e.failed,
    ).length;
    const errorCount = logEntries.filter((e) => e.failed).length;
    console.log(`  ${separator}`);
    const parts = [`${newCount} new`, `${cacheCount} from cache`];
    if (errorCount > 0)
      parts.push(`${errorCount} ${errorCount === 1 ? "error" : "errors"}`);
    console.log(`  ${parts.join(", ")}. ${pc.dim(`${elapsed}s`)}`);
    console.log("");
  }

  if (registryEntries.length === 0) {
    return;
  }

  const output = generateTypeDeclarations(registryEntries);
  await fs.writeFile(outFile, output, "utf-8");
  logger.debug("Wrote serving types to %s", outFile);

  if (updated) {
    await saveServingCache(cache as ServingCache);
  }
}

function resolveDefaultEndpoints(): Record<string, EndpointConfig> {
  if (process.env.DATABRICKS_SERVING_ENDPOINT) {
    return { default: { env: "DATABRICKS_SERVING_ENDPOINT" } };
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

declare module "@databricks/appkit" {
  interface ServingEndpointRegistry {
${entries.join("\n")}
  }
}
`;
}

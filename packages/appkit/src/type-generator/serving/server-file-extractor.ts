import fs from "node:fs";
import path from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { createLogger } from "../../logging/logger";
import type { EndpointConfig } from "../../plugins/serving/types";

const logger = createLogger("type-generator:serving:extractor");

/**
 * Candidate paths for the server entry file, relative to the project root.
 * Checked in order; the first that exists is used.
 * Same convention as plugin sync (sync.ts SERVER_FILE_CANDIDATES).
 */
const SERVER_FILE_CANDIDATES = ["server/index.ts", "server/server.ts"];

/**
 * Find the server entry file by checking candidate paths in order.
 *
 * @param basePath - Project root directory to search from
 * @returns Absolute path to the server file, or null if none found
 */
export function findServerFile(basePath: string): string | null {
  for (const candidate of SERVER_FILE_CANDIDATES) {
    const fullPath = path.join(basePath, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Extract serving endpoint config from a server file by AST-parsing it.
 * Looks for `serving({ endpoints: { alias: { env: "..." }, ... } })` calls
 * and extracts the endpoint alias names and their environment variable mappings.
 *
 * @param serverFilePath - Absolute path to the server entry file
 * @returns Extracted endpoint config, or null if not found or not extractable
 */
export function extractServingEndpoints(
  serverFilePath: string,
): Record<string, EndpointConfig> | null {
  let content: string;
  try {
    content = fs.readFileSync(serverFilePath, "utf-8");
  } catch {
    logger.debug("Could not read server file: %s", serverFilePath);
    return null;
  }

  const lang = serverFilePath.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript;
  const ast = parse(lang, content);
  const root = ast.root();

  // Find serving(...) call expressions
  const servingCall = findServingCall(root);
  if (!servingCall) {
    logger.debug("No serving() call found in %s", serverFilePath);
    return null;
  }

  // Get the first argument (the config object)
  const args = servingCall.field("arguments");
  if (!args) {
    return null;
  }

  const configArg = args.children().find((child) => child.kind() === "object");
  if (!configArg) {
    // serving() called with no args or non-object arg
    return null;
  }

  // Find the "endpoints" property in the config object
  const endpointsPair = findProperty(configArg, "endpoints");
  if (!endpointsPair) {
    // Config object has no "endpoints" property (e.g. serving({ timeout: 5000 }))
    return null;
  }

  // Get the value of the endpoints property
  const endpointsValue = getPropertyValue(endpointsPair);
  if (!endpointsValue || endpointsValue.kind() !== "object") {
    // endpoints is a variable reference, not an inline object
    logger.debug(
      "serving() endpoints is not an inline object literal in %s. " +
        "Pass endpoints explicitly via appKitServingTypesPlugin({ endpoints }) in vite.config.ts.",
      serverFilePath,
    );
    return null;
  }

  // Extract each endpoint entry
  const endpoints: Record<string, EndpointConfig> = {};
  const pairs = endpointsValue
    .children()
    .filter((child) => child.kind() === "pair");

  for (const pair of pairs) {
    const entry = extractEndpointEntry(pair);
    if (entry) {
      endpoints[entry.alias] = entry.config;
    }
  }

  if (Object.keys(endpoints).length === 0) {
    return null;
  }

  logger.debug(
    "Extracted %d endpoint(s) from %s: %s",
    Object.keys(endpoints).length,
    serverFilePath,
    Object.keys(endpoints).join(", "),
  );

  return endpoints;
}

/**
 * Find the serving() call expression in the AST.
 * Looks for call expressions where the callee identifier is "serving".
 */
function findServingCall(root: SgNode): SgNode | null {
  const callExpressions = root.findAll({
    rule: { kind: "call_expression" },
  });

  for (const call of callExpressions) {
    const callee = call.children()[0];
    if (callee?.kind() === "identifier" && callee.text() === "serving") {
      return call;
    }
  }

  return null;
}

/**
 * Find a property (pair node) with the given key name in an object expression.
 */
function findProperty(objectNode: SgNode, propertyName: string): SgNode | null {
  const pairs = objectNode
    .children()
    .filter((child) => child.kind() === "pair");

  for (const pair of pairs) {
    const key = pair.children()[0];
    if (!key) continue;

    const keyText =
      key.kind() === "property_identifier"
        ? key.text()
        : key.kind() === "string"
          ? key.text().replace(/^['"]|['"]$/g, "")
          : null;

    if (keyText === propertyName) {
      return pair;
    }
  }

  return null;
}

/**
 * Get the value node from a pair (property: value).
 * The value is typically the last meaningful child after the colon.
 */
function getPropertyValue(pairNode: SgNode): SgNode | null {
  const children = pairNode.children();
  // pair children: [key, ":", value]
  return children.length >= 3 ? children[children.length - 1] : null;
}

/**
 * Extract a single endpoint entry from a pair node like:
 * `demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME", servedModel: "my-model" }`
 */
function extractEndpointEntry(
  pair: SgNode,
): { alias: string; config: EndpointConfig } | null {
  const children = pair.children();
  if (children.length < 3) return null;

  // Get alias name (the key)
  const keyNode = children[0];
  const alias =
    keyNode.kind() === "property_identifier"
      ? keyNode.text()
      : keyNode.kind() === "string"
        ? keyNode.text().replace(/^['"]|['"]$/g, "")
        : null;

  if (!alias) return null;

  // Get the value (should be an object like { env: "..." })
  const valueNode = children[children.length - 1];
  if (valueNode.kind() !== "object") return null;

  // Extract env field
  const envPair = findProperty(valueNode, "env");
  if (!envPair) return null;

  const envValue = getPropertyValue(envPair);
  if (!envValue || envValue.kind() !== "string") return null;

  const env = envValue.text().replace(/^['"]|['"]$/g, "");

  // Extract optional servedModel field
  const config: EndpointConfig = { env };
  const servedModelPair = findProperty(valueNode, "servedModel");
  if (servedModelPair) {
    const servedModelValue = getPropertyValue(servedModelPair);
    if (servedModelValue?.kind() === "string") {
      config.servedModel = servedModelValue.text().replace(/^['"]|['"]$/g, "");
    }
  }

  return { alias, config };
}

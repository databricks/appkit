import { ApiError, type WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";

const logger = createLogger("type-generator:serving:fetcher");

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface OpenApiOperation {
  requestBody?: {
    content: {
      "application/json": {
        schema: OpenApiSchema;
      };
    };
  };
  responses?: Record<
    string,
    {
      content?: {
        "application/json": {
          schema: OpenApiSchema;
        };
      };
    }
  >;
}

export interface OpenApiSchema {
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  enum?: string[];
  nullable?: boolean;
  oneOf?: OpenApiSchema[];
  format?: string;
}

/**
 * Fetches the OpenAPI schema for a serving endpoint using the SDK.
 * Returns null if the endpoint is not found or access is denied.
 */
export async function fetchOpenApiSchema(
  client: WorkspaceClient,
  endpointName: string,
  servedModel?: string,
): Promise<{ spec: OpenApiSpec; pathKey: string } | null> {
  try {
    const response = await client.servingEndpoints.getOpenApi({
      name: endpointName,
    });

    if (!response.contents) {
      logger.warn(
        "Empty OpenAPI response for '%s', skipping type generation",
        endpointName,
      );
      return null;
    }

    const text = await new Response(response.contents).text();
    const rawSpec: unknown = JSON.parse(text);

    if (
      typeof rawSpec !== "object" ||
      rawSpec === null ||
      !("paths" in rawSpec) ||
      typeof (rawSpec as OpenApiSpec).paths !== "object"
    ) {
      logger.warn(
        "Invalid OpenAPI schema structure for '%s', skipping",
        endpointName,
      );
      return null;
    }
    const spec = rawSpec as OpenApiSpec;

    // Find the right path key
    const pathKeys = Object.keys(spec.paths ?? {});
    if (pathKeys.length === 0) {
      logger.warn("No paths in OpenAPI schema for '%s'", endpointName);
      return null;
    }

    let pathKey: string;
    if (servedModel) {
      const match = pathKeys.find((k) => k.includes(`/${servedModel}/`));
      if (!match) {
        logger.warn(
          "Served model '%s' not found in schema for '%s', using first path",
          servedModel,
          endpointName,
        );
        pathKey = pathKeys[0];
      } else {
        pathKey = match;
      }
    } else {
      pathKey = pathKeys[0];
    }

    return { spec, pathKey };
  } catch (err) {
    if (err instanceof ApiError) {
      const status = err.statusCode ?? 0;
      if (status === 404) {
        logger.warn(
          "Endpoint '%s' not found, skipping type generation",
          endpointName,
        );
      } else if (status === 403) {
        logger.warn(
          "Access denied to endpoint '%s' schema, skipping type generation",
          endpointName,
        );
      } else {
        logger.warn(
          "Failed to fetch schema for '%s' (HTTP %d), skipping: %s",
          endpointName,
          status,
          err.message,
        );
      }
    } else {
      logger.warn(
        "Error fetching schema for '%s': %s",
        endpointName,
        (err as Error).message,
      );
    }
    return null;
  }
}

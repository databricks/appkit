import type { OpenApiOperation, OpenApiSchema } from "./fetcher";

/**
 * Converts an OpenAPI schema to a TypeScript type string.
 */
function schemaToTypeString(schema: OpenApiSchema, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (schema.oneOf) {
    return schema.oneOf.map((s) => schemaToTypeString(s, indent)).join(" | ");
  }

  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      if (!schema.items) return "unknown[]";
      const itemType = schemaToTypeString(schema.items, indent);
      // Wrap union types in parens for array
      if (itemType.includes(" | ") && !itemType.startsWith("{")) {
        return `(${itemType})[]`;
      }
      return `${itemType}[]`;
    }
    case "object": {
      if (!schema.properties) return "Record<string, unknown>";
      const required = new Set(schema.required ?? []);
      const entries = Object.entries(schema.properties).map(([key, prop]) => {
        const optional = !required.has(key) ? "?" : "";
        const nullable = prop.nullable ? " | null" : "";
        const typeStr = schemaToTypeString(prop, indent + 1);
        const formatComment =
          prop.format && (prop.type === "number" || prop.type === "integer")
            ? `/** @openapi ${prop.format}${prop.nullable ? ", nullable" : ""} */\n${pad}  `
            : prop.nullable && prop.type === "integer"
              ? `/** @openapi integer, nullable */\n${pad}  `
              : "";
        return `${pad}  ${formatComment}${key}${optional}: ${typeStr}${nullable};`;
      });
      return `{\n${entries.join("\n")}\n${pad}}`;
    }
    default:
      return "unknown";
  }
}

/**
 * Extracts the top-level property keys from the request schema.
 * Strips the `stream` property (plugin-controlled).
 */
export function extractRequestKeys(operation: OpenApiOperation): string[] {
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  if (!schema?.properties) return [];
  return Object.keys(schema.properties).filter((k) => k !== "stream");
}

/**
 * Extracts and converts the request schema from an OpenAPI path operation.
 * Strips the `stream` property from the request type.
 */
export function convertRequestSchema(operation: OpenApiOperation): string {
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  if (!schema || !schema.properties) return "Record<string, unknown>";

  // Strip `stream` property — the plugin controls this
  const { stream: _stream, ...filteredProps } = schema.properties;
  const filteredRequired = (schema.required ?? []).filter(
    (r) => r !== "stream",
  );

  const filteredSchema: OpenApiSchema = {
    ...schema,
    properties: filteredProps,
    required: filteredRequired.length > 0 ? filteredRequired : undefined,
  };

  return schemaToTypeString(filteredSchema);
}

/**
 * Extracts and converts the response schema from an OpenAPI path operation.
 */
export function convertResponseSchema(operation: OpenApiOperation): string {
  const response = operation.responses?.["200"];
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) return "unknown";
  return schemaToTypeString(schema);
}

/**
 * Derives a streaming chunk type from the response schema.
 * Returns null if the response doesn't follow OpenAI-compatible format.
 *
 * OpenAI-compatible heuristic: response has `choices` array where items
 * have a `message` object property.
 */
export function deriveChunkType(operation: OpenApiOperation): string | null {
  const response = operation.responses?.["200"];
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema?.properties) return null;

  const choicesProp = schema.properties.choices;
  if (!choicesProp || choicesProp.type !== "array" || !choicesProp.items)
    return null;

  const choiceItemProps = choicesProp.items.properties;
  if (!choiceItemProps?.message) return null;

  // It's OpenAI-compatible. Build the chunk type by transforming.
  const messageSchema = choiceItemProps.message;

  // Build chunk schema: replace message with delta (Partial), make finish_reason nullable, drop usage
  const chunkProperties: Record<string, OpenApiSchema> = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key === "usage") continue; // Drop usage from chunks
    if (key === "choices") {
      // Transform choices items
      const chunkChoiceProps: Record<string, OpenApiSchema> = {};
      for (const [ck, cp] of Object.entries(choiceItemProps)) {
        if (ck === "message") {
          // Replace message with delta: Partial<message>
          chunkChoiceProps.delta = { ...messageSchema };
        } else if (ck === "finish_reason") {
          chunkChoiceProps[ck] = { ...cp, nullable: true };
        } else {
          chunkChoiceProps[ck] = cp;
        }
      }
      chunkProperties[key] = {
        type: "array",
        items: {
          type: "object",
          properties: chunkChoiceProps,
        },
      };
    } else {
      chunkProperties[key] = prop;
    }
  }

  const chunkSchema: OpenApiSchema = {
    type: "object",
    properties: chunkProperties,
  };

  // Delta properties are already optional (no `required` array in the schema),
  // so schemaToTypeString renders them with `?:` — no Partial<> wrapper needed.
  return schemaToTypeString(chunkSchema);
}

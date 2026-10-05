import type {
  ExtractField,
  ExtractMetadata,
  ExtractResponse,
  ExtractSchema,
  ExtractValues,
  ScoreAnswer,
  SpanCitation,
} from "./ai-functions";

const LEAF_TYPES = new Set(["string", "number", "integer", "boolean", "enum"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafValue(field: unknown): unknown {
  return isRecord(field) && "value" in field ? (field.value ?? null) : null;
}

function nodeValue(node: unknown, field: unknown): unknown {
  if (!isRecord(node) || "enum" in node) return field;
  const { type } = node;
  if (typeof type === "string" && LEAF_TYPES.has(type)) return leafValue(field);
  if (type === "array") {
    return Array.isArray(field)
      ? field.map((item) => nodeValue(node.items, item))
      : [];
  }
  if (type === "object") {
    return propertiesValue(
      isRecord(node.properties) ? node.properties : {},
      field,
    );
  }
  return field;
}

function propertiesValue(
  properties: Record<string, unknown>,
  field: unknown,
): Record<string, unknown> {
  const source = isRecord(field) ? field : {};
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    values[key] = nodeValue(properties[key], source[key]);
  }
  return values;
}

/**
 * Removes the `{ value }` wrappers from an extract response, guided by the
 * schema that produced it. Missing leaves become `null`, missing arrays `[]`.
 * Returns `undefined` when the response has no `response` field.
 */
export function extractValues<const S extends ExtractSchema>(
  result: ExtractResponse<unknown>,
  schema: S,
): ExtractValues<S> | undefined {
  const response: unknown = result.response;
  if (response === undefined) return undefined;
  if (Array.isArray(schema)) {
    const source = isRecord(response) ? response : {};
    const values: Record<string, unknown> = {};
    for (const name of schema as readonly string[])
      values[name] = leafValue(source[name]);
    return values as ExtractValues<S>;
  }
  return propertiesValue(
    schema as Record<string, unknown>,
    response,
  ) as ExtractValues<S>;
}

/**
 * Returns the text each of a field's span citations points to, sliced from
 * the same `content` string sent to extract. Returns `[]` for bounding-box
 * citations, non-string content, or fields without citations.
 */
export function citedText(
  content: unknown,
  field: ExtractField<unknown> | undefined,
  metadata: ExtractMetadata | undefined,
): string[] {
  if (typeof content !== "string" || metadata?.chunk_type !== "span") return [];
  const ids = field?.citation_ids;
  if (!ids?.length) return [];
  const spans = new Map<number, SpanCitation>();
  for (const citation of metadata.citations ?? []) {
    if ("start" in citation) spans.set(citation.id, citation);
  }
  return ids.flatMap((id) => {
    const span = spans.get(id);
    return span ? [content.slice(span.start, span.stop)] : [];
  });
}

/**
 * Maps a decide score (a probability-weighted average of level indexes) to
 * its nearest level, clamped to the legend's range.
 */
export function scoreLevel(answer: ScoreAnswer): {
  index: number;
  level: unknown;
} {
  const indexes = Object.keys(answer.legend)
    .map(Number)
    .filter(Number.isInteger);
  const min = indexes.length > 0 ? Math.min(...indexes) : 0;
  const max = indexes.length > 0 ? Math.max(...indexes) : 0;
  const index = Math.min(Math.max(Math.round(answer.score), min), max);
  return { index, level: answer.legend[String(index)] };
}

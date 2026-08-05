import type { MetricColumnMetadata, MetricSchema } from "./types";

/**
 * @todo unify with query-registry.ts
 * Map a Databricks SQL type to a TypeScript primitive.
 * Centralized here (not imported from query-registry) so this module
 * stays self-contained.
 */
function tsTypeFor(sqlType: string): string {
  const normalized = sqlType
    .toUpperCase()
    .replace(/\(.*\)$/, "")
    .replace(/<.*>$/, "")
    .split(" ")[0];

  switch (normalized) {
    case "BOOLEAN":
      return "boolean";
    case "TINYINT":
    case "SMALLINT":
    case "INT":
    case "INTEGER":
    case "BIGINT":
    case "FLOAT":
    case "DOUBLE":
    case "DECIMAL":
    case "NUMERIC":
      return "number";
    default:
      return "string";
  }
}

// Render a MetricRegistry interface entry from a MetricSchema.
function renderMetricEntry(schema: MetricSchema): string {
  if (schema.degraded) {
    return renderDegradedMetricEntry(schema);
  }
  const indent = "      ";
  const colsBlock = (cols: MetricColumnMetadata[]): string => {
    if (cols.length === 0) return "Record<string, never>";
    const fields = cols
      .map((col) => {
        const grainComment = col.timeGrains?.length
          ? ` @timeGrain ${col.timeGrains.join("|")}`
          : "";
        return `${indent}/** @sqlType ${col.type.replace(/\*\//g, "* /")}${grainComment} */
${indent}${JSON.stringify(col.name)}: ${tsTypeFor(col.type)}`;
      })
      .join(";\n");
    return `{
${fields};
    }`;
  };
  const unionOf = (keys: string[]): string =>
    keys.length > 0 ? keys.join(" | ") : "never";

  const measuresBlock = colsBlock(schema.measures);
  const dimensionsBlock = colsBlock(schema.dimensions);
  const measureUnion = unionOf(
    schema.measures.map((m) => JSON.stringify(m.name)),
  );
  const dimensionUnion = unionOf(
    schema.dimensions.map((d) => JSON.stringify(d.name)),
  );

  const timeGrainSet = new Set<string>();
  for (const d of schema.dimensions) {
    for (const g of d.timeGrains ?? []) {
      timeGrainSet.add(g);
    }
  }
  const timeGrainUnion =
    timeGrainSet.size > 0
      ? [...timeGrainSet]
          .sort()
          .map((g) => JSON.stringify(g))
          .join(" | ")
      : "never";

  const measureMetadata = renderMetadataMap(schema.measures, indent);
  const dimensionMetadata = renderMetadataMap(schema.dimensions, indent, true);

  return `    ${JSON.stringify(schema.key)}: {
      key: ${JSON.stringify(schema.key)};
      source: ${JSON.stringify(schema.source)};
      lane: ${JSON.stringify(schema.lane)};
      measures: ${measuresBlock};
      dimensions: ${dimensionsBlock};
      measureKeys: ${measureUnion};
      dimensionKeys: ${dimensionUnion};
      timeGrains: ${timeGrainUnion};
      metadata: {
        measures: ${measureMetadata};
        dimensions: ${dimensionMetadata};
      };
    }`;
}

// Render the permissive ("degraded-open") entry for a schema the warehouse could not describe.
function renderDegradedMetricEntry(schema: MetricSchema): string {
  return `    /** Degraded: schema unavailable at type-generation time — permissive types until a successful DESCRIBE refreshes them. */
    ${JSON.stringify(schema.key)}: {
      key: ${JSON.stringify(schema.key)};
      source: ${JSON.stringify(schema.source)};
      lane: ${JSON.stringify(schema.lane)};
      measures: Record<string, unknown>;
      dimensions: Record<string, unknown>;
      measureKeys: string;
      dimensionKeys: string;
      timeGrains: string;
      metadata: {
        measures: Record<string, never>;
        dimensions: Record<string, never>;
      };
    }`;
}

type RenderedMetadataField = readonly [name: string, value: string];

// Rendered per-column fields shared by the type-level and runtime metadata.
// `time_grain` is type-only, so it is included only when requested.
function metadataFields(
  col: MetricColumnMetadata,
  includeTimeGrain = false,
): RenderedMetadataField[] {
  const fields: RenderedMetadataField[] = [["type", JSON.stringify(col.type)]];
  const optionalFields = [
    ["display_name", col.displayName],
    ["format", col.format],
    ["description", col.description],
  ] as const;

  for (const [name, value] of optionalFields) {
    if (value) {
      fields.push([name, JSON.stringify(value)]);
    }
  }

  if (includeTimeGrain && col.timeGrains && col.timeGrains.length > 0) {
    const grainTuple = col.timeGrains.map((g) => JSON.stringify(g)).join(", ");
    fields.push(["time_grain", `readonly [${grainTuple}]`]);
  }

  return fields;
}

// Render the type-level shape of a column's semantic-metadata map
// for the `metadata` field of a MetricRegistry entry.
function renderMetadataMap(
  cols: MetricColumnMetadata[],
  indent: string,
  includeTimeGrain = false,
): string {
  if (cols.length === 0) return "Record<string, never>";

  const inner = cols
    .map((col) => {
      const fieldsBlock = metadataFields(col, includeTimeGrain)
        .map(([name, value]) => `${indent}  ${name}: ${value}`)
        .join(";\n");
      return `${indent}${JSON.stringify(col.name)}: {
${fieldsBlock};
${indent}}`;
    })
    .join(";\n");

  return `{
${inner};
    }`;
}

// Value-side twin of a `renderMetadataMap` entry, minus `time_grain` (not part
// of MetricViewColumnDisplay).
function renderMetadataValueField(col: MetricColumnMetadata): string {
  const fields = metadataFields(col).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return `{ ${fields.join(", ")} }`;
}

// Render one metric's runtime measures/dimensions map, keyed by column name.
function renderMetadataValueMap(
  cols: MetricColumnMetadata[],
  indent: string,
): string {
  if (cols.length === 0) return "{}";
  const inner = cols
    .map(
      (col) =>
        `${indent}  ${JSON.stringify(col.name)}: ${renderMetadataValueField(col)}`,
    )
    .join(",\n");
  return `{
${inner},
${indent}}`;
}

// Render the runtime `metricViewsMetadata` const, emitted `as const` in the
// same key order as the augmentation.
function renderMetricViewsMetadata(schemas: MetricSchema[]): string {
  if (schemas.length === 0) {
    return "export const metricViewsMetadata = {} as const;\n";
  }
  const entries = schemas
    .map((schema) => {
      const measures = renderMetadataValueMap(schema.measures, "    ");
      const dimensions = renderMetadataValueMap(schema.dimensions, "    ");
      return `  ${JSON.stringify(schema.key)}: {
    measures: ${measures},
    dimensions: ${dimensions},
  }`;
    })
    .join(",\n");
  return `export const metricViewsMetadata = {
${entries},
} as const;
`;
}

// Render the augmentation block for the appkit-ui MetricRegistry interface.
function renderMetricRegistry(schemas: MetricSchema[]): string {
  if (schemas.length === 0) {
    return `declare module "@databricks/appkit-ui/react" {
  interface MetricRegistry {}
}
`;
  }
  const entries = schemas.map(renderMetricEntry).join(";\n");
  return `declare module "@databricks/appkit-ui/react" {
  interface MetricRegistry {
${entries};
  }
}
`;
}

/**
 * Build the full metric-views.ts file from a list of metric schemas.
 *
 * The header must stay a type-only `import type {} from`: it anchors the module
 * so the augmentation resolves while compiling to zero runtime code, whereas a
 * bare `import "@databricks/appkit-ui/react"` would execute the client package
 * entry on the Node server.
 */
export function generateMetricTypeDeclarations(
  schemas: MetricSchema[],
): string {
  return `// Auto-generated by AppKit - DO NOT EDIT
// Generated by 'npx @databricks/appkit generate-types' or Vite plugin during build
import type {} from "@databricks/appkit-ui/react";
${renderMetricRegistry(schemas)}
${renderMetricViewsMetadata(schemas)}`;
}

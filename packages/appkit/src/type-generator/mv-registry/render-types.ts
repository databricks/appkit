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
      const fields: string[] = [`type: ${JSON.stringify(col.type)}`];
      if (col.displayName) {
        fields.push(`display_name: ${JSON.stringify(col.displayName)}`);
      }
      if (col.format) {
        fields.push(`format: ${JSON.stringify(col.format)}`);
      }
      if (col.description) {
        fields.push(`description: ${JSON.stringify(col.description)}`);
      }
      if (includeTimeGrain && col.timeGrains && col.timeGrains.length > 0) {
        const grainTuple = col.timeGrains
          .map((g) => JSON.stringify(g))
          .join(", ");
        fields.push(`time_grain: readonly [${grainTuple}]`);
      }
      const fieldsBlock = fields.map((f) => `${indent}  ${f}`).join(";\n");
      return `${indent}${JSON.stringify(col.name)}: {
${fieldsBlock};
${indent}}`;
    })
    .join(";\n");

  return `{
${inner};
    }`;
}

// Render one column's runtime metadata object literal — the value-side twin of
// a `renderMetadataMap` entry. Sources the SAME per-column fields
// (type/display_name/format/description) but omits `time_grain` (not part of
// MetricColumnMeta). Strings go through JSON.stringify so quotes/backticks in
// display_name/description stay escape-safe.
function renderMetadataValueField(col: MetricColumnMetadata): string {
  const fields: string[] = [`type: ${JSON.stringify(col.type)}`];
  if (col.displayName) {
    fields.push(`display_name: ${JSON.stringify(col.displayName)}`);
  }
  if (col.format) {
    fields.push(`format: ${JSON.stringify(col.format)}`);
  }
  if (col.description) {
    fields.push(`description: ${JSON.stringify(col.description)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

// Render the runtime value map (measures or dimensions) for one metric — an
// object literal keyed by column name. Empty → `{}` (the value twin of the
// type-level `Record<string, never>`, which is a type-only construct).
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

// Render the runtime `metricViewsMetadata` const — a value twin of the
// type-level `metadata` blocks, conforming to MetricViewsMetadata from
// "shared". Emitted `as const`. Iterates `schemas` in the SAME order as the
// type augmentation. A degraded schema (empty measure/dimension arrays)
// contributes empty `measures: {}` / `dimensions: {}` maps, consistent with
// its degraded type block.
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

// Build the full metric-views.ts file from a list of metric schemas.
//
// This is a real `.ts` source file (not a `.d.ts`), so it carries BOTH the
// erasable `declare module` type augmentation AND a runtime value export
// (`metricViewsMetadata`). It must therefore never emit a runtime side-effect
// import — a bare `import "@databricks/appkit-ui/react"` would execute the
// client package entry on the Node server. The header is a type-only
// `import type {} from "..."`, which (a) compiles to zero runtime code and
// (b) anchors the module so the global `declare module` augmentation resolves.
export function generateMetricTypeDeclarations(
  schemas: MetricSchema[],
): string {
  return `// Auto-generated by AppKit - DO NOT EDIT
// Generated by 'npx @databricks/appkit generate-types' or Vite plugin during build
import type {} from "@databricks/appkit-ui/react";
${renderMetricRegistry(schemas)}
${renderMetricViewsMetadata(schemas)}`;
}

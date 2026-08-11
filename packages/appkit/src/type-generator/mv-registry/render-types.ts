import type { MetricViewColumnDisplay } from "../../../../shared/src/metric-metadata";
import {
  METRIC_METADATA_BUNDLE_VERSION,
  type MetricMetadataBundle,
} from "../../../../shared/src/schemas/metric-metadata-bundle";
import type { MetricColumnMetadata, MetricSchema } from "./types";

/**
 * Metric results use Databricks' JSON_ARRAY delivery, whose scalar cells are
 * strings regardless of their SQL type. Every selected column can also be SQL
 * NULL. Keep the generated row contract faithful to that wire shape; callers
 * can use the generated SQL-type metadata when they intentionally need to
 * parse a value.
 */
const JSON_ARRAY_WIRE_TYPE = "string | null";

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
${indent}${JSON.stringify(col.name)}: ${JSON_ARRAY_WIRE_TYPE}`;
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

// Value-side twin of a `renderMetadataMap` entry, minus `time_grain` (which is
// type-only and not part of MetricViewColumnDisplay).
function metadataValue(col: MetricColumnMetadata): MetricViewColumnDisplay {
  const value: MetricViewColumnDisplay = { type: col.type };
  if (col.displayName) value.display_name = col.displayName;
  if (col.format) value.format = col.format;
  if (col.description) value.description = col.description;
  return value;
}

function metadataValueMap(
  cols: MetricColumnMetadata[],
): Record<string, MetricViewColumnDisplay> {
  const map: Record<string, MetricViewColumnDisplay> = {};
  for (const col of cols) {
    map[col.name] = metadataValue(col);
  }
  return map;
}

/**
 * Build the runtime metadata bundle written to
 * `config/metric-views/metadata.generated.json`.
 *
 * The value twin of the augmentation's `metadata` field, carried in JSON rather
 * than as a TypeScript `const` so the analytics plugin can read it from disk
 * without the app importing and injecting it. Keeping it out of the type
 * artifact is also what lets that artifact stay a declaration-only `.d.ts`: an
 * object-literal `const` in an ambient context is a TS1254 error.
 *
 * Entries keep the same key order as the augmentation. Degraded schemas
 * contribute empty maps — the warehouse could not describe their columns, so
 * there is no display metadata to stamp.
 */
export function buildMetricMetadataBundle(
  schemas: MetricSchema[],
): MetricMetadataBundle {
  const metricViews: MetricMetadataBundle["metricViews"] = {};
  for (const schema of schemas) {
    metricViews[schema.key] = {
      measures: metadataValueMap(schema.measures),
      dimensions: metadataValueMap(schema.dimensions),
    };
  }
  return { version: METRIC_METADATA_BUNDLE_VERSION, metricViews };
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
 * Build the full metric-views.d.ts file from a list of metric schemas.
 *
 * Declaration-only: the runtime metadata twin ships as a JSON bundle (see
 * {@link buildMetricMetadataBundle}), so nothing here compiles to a value and
 * the file can be ambient.
 *
 * The header import is required and must not be dropped: it marks this file a
 * module, which is what makes `declare module` an *augmentation* that merges
 * into the real one. Without it the block is an ambient declaration that
 * SHADOWS `@databricks/appkit-ui/react`, and every genuine export of that
 * module (`useMetricView`, the components) disappears. The form matches the
 * sibling `analytics.d.ts` / `serving.d.ts` headers; a `.d.ts` never emits JS,
 * so it costs nothing at runtime.
 */
export function generateMetricTypeDeclarations(
  schemas: MetricSchema[],
): string {
  return `// Auto-generated by AppKit - DO NOT EDIT
// Generated by 'npx @databricks/appkit generate-types' or Vite plugin during build
import "@databricks/appkit-ui/react";
${renderMetricRegistry(schemas)}`;
}

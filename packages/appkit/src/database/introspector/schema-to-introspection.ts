import type { Schema } from "../schema-builder/types";
import { adaptDrizzleTable } from "./drizzle-adapter";
import type { IntrospectionResult } from "./types";

export function schemaToIntrospection(schema: Schema): IntrospectionResult {
  // All Drizzle-specific metadata reads stay behind adaptDrizzleTable so drift
  // checks consume the same stable shape as live introspection.
  const tables = Object.entries(schema.$tables).map(([entityName, table]) => {
    const adapted = adaptDrizzleTable(table);
    return {
      schema: adapted.schema,
      name: table.name ?? entityName,
      columns: adapted.columns,
      policies: [],
    };
  });

  return {
    schemas: [...new Set(tables.map((table) => table.schema))],
    tables,
  };
}

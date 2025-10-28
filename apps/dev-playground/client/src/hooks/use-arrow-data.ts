import { tableFromIPC } from "apache-arrow";
import * as aq from "arquero";
import { useMemo } from "react";

export type ColumnSchema = {
  name: string;
  type: "quantitative" | "temporal" | "nominal" | "ordinal" | "boolean";
  nullable: boolean;
};

export type ArrowVegaData = {
  data: Record<string, any>[];
  schema: ColumnSchema[];
};

/**
 * Hook: Convert Arrow IPC buffer → sampled JS objects + Vega-Lite schema
 */
export function useArrowData(
  buffer: Uint8Array,
  sampleSize: number = 1000
): ArrowVegaData {
  return useMemo(() => {
    if (!buffer) return { data: [], schema: [] };

    const arrowTable = tableFromIPC(buffer);

    let table = aq.fromArrow(buffer);

    if (table.numRows() > sampleSize) {
      table = table.slice(0, sampleSize);
    }

    const data = table.objects().map((row) => {
      const converted: Record<string, any> = {};
      for (const key in row) {
        const value = row[key as keyof typeof row];
        if (typeof value === "bigint") {
          // safe for numeric fields < 2^53
          converted[key] = Number(value);
        } else {
          converted[key] = value;
        }
      }
      return converted;
    });

    console.log(arrowTable.schema);
    // 5️⃣ Derive schema for Vega-Lite
    const schema = arrowTable.schema.fields.map((field) => {
      let type: "quantitative" | "temporal" | "nominal" | "boolean";

      switch (field.type.typeId) {
        case 2: // Int / UInt
        case 3: // Float / Double
          type = "quantitative";
          break;
        case 10: // Timestamp
          type = "temporal";
          break;
        case 20: // Boolean
          type = "boolean";
          break;
        default:
          type = "nominal";
      }

      return {
        name: field.name,
        type,
        nullable: field.nullable,
      };
    });

    return { data, schema };
  }, [buffer, sampleSize]);
}

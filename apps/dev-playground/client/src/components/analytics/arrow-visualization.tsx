import { useMemo } from "react";
import { VegaEmbed, type VegaEmbedProps } from "react-vega";
import { useArrowData } from "../../hooks/use-arrow-data";

export interface ArrowVegaChartProps {
  buffer: Uint8Array;
  type: Extract<VegaEmbedProps["spec"], { mark: unknown }>["mark"];
  description?: string;
  xConfig?: {
    field?: string;
    title?: string;
  };
  yConfig?: {
    field?: string;
    title?: string;
  };
  maxRows?: number;
}

export function ArrowVegaChart({
  buffer,
  type = "line",
  description = "",
  xConfig = { field: "x", title: "x" },
  yConfig = { field: "y", title: "y" },
  maxRows = 1000,
}: ArrowVegaChartProps) {
  const { data, schema } = useArrowData(buffer, maxRows);
  const autoXField =
    xConfig.field ?? schema.find((c) => c.type === "quantitative")?.name ?? "x";
  const autoYField =
    yConfig.field ?? schema.find((c) => c.type === "quantitative")?.name ?? "y";
  const spec = useMemo(
    () =>
      ({
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        description: description,
        width: 600,
        height: 400,
        mark: { type },
        encoding: {
          x: { field: autoXField, type: "quantitative", title: xConfig.title },
          y: { field: autoYField, type: "quantitative", title: yConfig.title },
        },
        data: { name: "dataset", values: data },
      }) as VegaEmbedProps["spec"],
    [data, type, autoXField, autoYField, xConfig, yConfig, description]
  );

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <VegaEmbed spec={spec} options={{ actions: false }} />
    </div>
  );
}

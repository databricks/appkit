import { ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { formatChartValue, formatFieldLabel } from "./utils";

interface ChartTooltipDefaultProps {
  config: Record<string, any>;
  indicator?: "dot" | "line" | "dashed";
  hideLabel?: boolean;
  formatLabel?: (value: any) => string;
}

/**
 * Default tooltip component for all charts with consistent formatting
 * Automatically formats dates and values
 * @param props - The props for the ChartTooltipDefault component
 * @param props.config - The config for the chart
 * @param props.indicator - The indicator for the chart
 * @param props.hideLabel - Whether to hide the label
 * @param props.formatLabel - A custom formatter for the label
 * @returns - The rendered ChartTooltipDefault component
 */
export function ChartTooltipDefault({
  config,
  indicator = "dot",
  hideLabel = false,
  formatLabel,
}: ChartTooltipDefaultProps) {
  return (
    <ChartTooltip
      content={
        <ChartTooltipContent
          className="min-w-[150px]"
          hideLabel={hideLabel}
          indicator={indicator}
          labelFormatter={(value) => {
            if (formatLabel) return formatLabel(value);

            if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
              return new Date(value).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              });
            }

            return String(value);
          }}
          formatter={(value: number, name: string) => (
            <div className="flex items-center justify-between gap-4 w-full">
              <span className="text-muted-foreground">
                {config[name]?.label || formatFieldLabel(name)}
              </span>
              <span className="text-foreground font-mono font-medium">
                {formatChartValue(value, name)}
              </span>
            </div>
          )}
        />
      }
    />
  );
}

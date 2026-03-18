import { BarChart3Icon, ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { GenieStatementResponse } from "shared";
import { BaseChart } from "../charts/base";
import { ChartErrorBoundary } from "../charts/chart-error-boundary";
import type { ChartType } from "../charts/types";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  getCompatibleChartTypes,
  inferChartType,
} from "./genie-chart-inference";
import { transformGenieData } from "./genie-query-transform";

const TABLE_ROW_LIMIT = 50;
const CHART_HEIGHT = 250;

const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  donut: "Donut",
  scatter: "Scatter",
  radar: "Radar",
  heatmap: "Heatmap",
};

interface GenieQueryVisualizationProps {
  /** Raw statement_response from the Genie API */
  data: GenieStatementResponse;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Renders a chart + data table for a Genie query result.
 *
 * - When a chart type can be inferred: shows Tabs with "Chart" (default) and "Table"
 * - When no chart fits: shows only the data table
 * - When data is empty/malformed: renders nothing
 */
export function GenieQueryVisualization({
  data,
  className,
}: GenieQueryVisualizationProps) {
  const transformed = useMemo(() => transformGenieData(data), [data]);
  const { inference, compatibleTypes } = useMemo(() => {
    if (!transformed)
      return { inference: null, compatibleTypes: [] as ChartType[] };
    const { rows, columns } = transformed;
    return {
      inference: inferChartType(rows, columns),
      compatibleTypes: getCompatibleChartTypes(rows, columns),
    };
  }, [transformed]);

  const [chartTypeOverride, setChartTypeOverride] = useState<ChartType | null>(
    null,
  );

  if (!transformed || transformed.rows.length === 0) return null;

  const { rows, columns } = transformed;
  const truncated = rows.length > TABLE_ROW_LIMIT;
  const displayRows = truncated ? rows.slice(0, TABLE_ROW_LIMIT) : rows;

  const activeChartType =
    chartTypeOverride && compatibleTypes.includes(chartTypeOverride)
      ? chartTypeOverride
      : (inference?.chartType ?? null);

  const dataTable = (
    <div className="overflow-auto max-h-[300px]">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.name}>{col.name}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayRows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tabular data rows have no unique identifier
            <TableRow key={i}>
              {columns.map((col) => (
                <TableCell key={col.name}>
                  {row[col.name] != null ? String(row[col.name]) : ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {truncated && (
        <p className="text-xs text-muted-foreground px-2 py-1">
          Showing {TABLE_ROW_LIMIT} of {rows.length} rows
        </p>
      )}
    </div>
  );

  if (!inference || !activeChartType) {
    return <div className={cn("min-w-0", className)}>{dataTable}</div>;
  }

  return (
    <Tabs defaultValue="chart" className={cn("min-w-0", className)}>
      <div className="flex items-center justify-between">
        <TabsList>
          <TabsTrigger value="chart">Chart</TabsTrigger>
          <TabsTrigger value="table">Table</TabsTrigger>
        </TabsList>
        {compatibleTypes.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Change chart type"
                className="gap-0.5"
              >
                <BarChart3Icon className="size-3.5" />
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Chart type</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={activeChartType}
                onValueChange={(v) => setChartTypeOverride(v as ChartType)}
              >
                {compatibleTypes.map((type) => (
                  <DropdownMenuRadioItem key={type} value={type}>
                    {CHART_TYPE_LABELS[type]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="grid min-w-0 [&>*]:col-start-1 [&>*]:row-start-1 [&>*]:min-w-0">
        <TabsContent
          value="chart"
          forceMount
          className="data-[state=inactive]:invisible"
        >
          <ChartErrorBoundary fallback={dataTable}>
            <BaseChart
              data={rows}
              chartType={activeChartType}
              xKey={inference.xKey}
              yKey={inference.yKey}
              height={CHART_HEIGHT}
              showLegend={Array.isArray(inference.yKey)}
            />
          </ChartErrorBoundary>
        </TabsContent>
        <TabsContent
          value="table"
          forceMount
          className="data-[state=inactive]:invisible"
        >
          {dataTable}
        </TabsContent>
      </div>
    </Tabs>
  );
}

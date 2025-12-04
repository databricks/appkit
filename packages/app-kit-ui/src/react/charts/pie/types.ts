import type { ChartConfig } from "../../ui/chart";

export interface PieChartProps {
  /** Analytics query key registered with analytics plugin */
  queryKey: string;
  /** Query Parameters passed to the analytics endpoint */
  parameters: Record<string, any>;
  /** Transform raw data before rendering */
  transformer?: (data: any[]) => any[];
  /** Chart configuration overrides */
  chartConfig?: ChartConfig;
  /** Child components for the pie chart */
  children?: React.ReactNode;
  /** Accessibility label for screen readers */
  ariaLabel?: string;
  /** Test ID for automated testing */
  testId?: string;
  /** Additional CSS classes */
  className?: string;
  /** Chart height @default 300px */
  height?: string;
  /** Inner radius of the pie chart */
  innerRadius?: number;
  /** Whether to show labels on the pie chart */
  showLabel?: boolean;
  /** Field to use for the label */
  labelField?: string;
  valueField?: string;
}

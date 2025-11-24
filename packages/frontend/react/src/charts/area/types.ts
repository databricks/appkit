import type { ChartConfig } from "../ui/chart";

/** Props for the AreaChart component */
export interface AreaChartProps {
  /** Analytics query key registered with analytics plugin */
  queryKey: string;
  /** Query Parameters passed to the analytics endpoint */
  parameters: Record<string, any>;

  /** Transform raw data before rendering */
  transformer?: (data: any[]) => any[];

  /** Chart configuration overrides */
  chartConfig?: ChartConfig;

  /** Custom Recharts component for full control mode */
  children?: React.ReactNode;

  /** Accessibility label for screen readers */
  ariaLabel?: string;
  /** Test ID for automated testing */
  testId?: string;

  /** Additional CSS classes */
  className?: string;
  /** Chart height @default 300px */
  height?: string;

  /** Curve type for the area */
  curveType?: "natural" | "linear" | "step" | "basis" | "monotone";
}

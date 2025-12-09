import type { ChartConfig } from "../../ui/chart";

/** Props for the BarChart component */
export interface BarChartProps {
  /** Analytics query key registered with analytics plugin */
  queryKey: string;
  /** Query Parameters passed to the analytics endpoint */
  parameters: Record<string, any>;

  /** Transform raw data before rendering */
  transformer?: (data: any[]) => any[];

  /** Char configuration overrides */
  chartConfig?: ChartConfig;
  /** Chart orientation @default vertical */
  orientation?: "horizontal" | "vertical";

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
}

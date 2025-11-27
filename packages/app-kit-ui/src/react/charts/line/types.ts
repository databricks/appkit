import type { ChartConfig } from "../ui/chart";

export interface LineChartProps {
  /** Analytics query key registered with analytics plugin */
  queryKey: string;
  /** Query Parameters passed to the analytics endpoint */
  parameters: Record<string, any>;
  /** Transform raw data before rendering */
  transformer?: (data: any[]) => any[];
  /** Custom Recharts component for full control mode */
  children?: React.ReactNode;
  /** Chart configuration overrides */
  chartConfig?: ChartConfig;
  /** Accessibility label for screen readers */
  ariaLabel?: string;
  /** Test ID for automated testing */
  testId?: string;
  /** Additional CSS classes */
  className?: string;
  /** Chart height @default 300px */
  height?: string;
  /** Curve type for the line */
  curveType?: "natural" | "linear" | "step" | "basis" | "monotone";
  /** Whether to show dots on the line */
  showDots?: boolean;
  /** Stroke width for the line */
  strokeWidth?: number;
}

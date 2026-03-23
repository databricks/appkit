import { DatabricksLogo } from "./databricks-logo";

export function AnalyticsHeader() {
  return (
    <header className="bg-background border-b border-gray-200 p-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-4 items-center">
          <DatabricksLogo />
          <p className="leading-7 text-foreground">Apps Cost Insights</p>
        </div>
        <div className="w-8 h-8 bg-destructive rounded-full flex items-center justify-center">
          <span className="text-foreground text-sm font-medium">S</span>
        </div>
      </div>
    </header>
  );
}

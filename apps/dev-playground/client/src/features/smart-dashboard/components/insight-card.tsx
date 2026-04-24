import { LightbulbIcon } from "lucide-react";

interface InsightCardProps {
  title: string;
  description: string;
}

export function InsightCard({ title, description }: InsightCardProps) {
  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/30 p-3">
      <div className="flex items-start gap-2">
        <LightbulbIcon className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground leading-tight">
            {title}
          </p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

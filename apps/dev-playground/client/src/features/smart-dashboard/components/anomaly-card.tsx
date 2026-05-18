import { AlertTriangleIcon } from "lucide-react";

type Severity = "low" | "medium" | "high";

interface AnomalyCardProps {
  title: string;
  description: string;
  severity: Severity;
}

const SEVERITY_STYLES: Record<
  Severity,
  { border: string; bg: string; icon: string; badge: string }
> = {
  low: {
    border: "border-yellow-200 dark:border-yellow-900",
    bg: "bg-yellow-50/50 dark:bg-yellow-950/30",
    icon: "text-yellow-500",
    badge:
      "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-400",
  },
  medium: {
    border: "border-orange-200 dark:border-orange-900",
    bg: "bg-orange-50/50 dark:bg-orange-950/30",
    icon: "text-orange-500",
    badge:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400",
  },
  high: {
    border: "border-red-200 dark:border-red-900",
    bg: "bg-red-50/50 dark:bg-red-950/30",
    icon: "text-red-500",
    badge: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400",
  },
};

export function AnomalyCard({
  title,
  description,
  severity,
}: AnomalyCardProps) {
  const styles = SEVERITY_STYLES[severity];

  return (
    <div className={`rounded-lg border ${styles.border} ${styles.bg} p-3`}>
      <div className="flex items-start gap-2">
        <AlertTriangleIcon
          className={`h-4 w-4 ${styles.icon} mt-0.5 shrink-0`}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground leading-tight">
              {title}
            </p>
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${styles.badge}`}
            >
              {severity}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

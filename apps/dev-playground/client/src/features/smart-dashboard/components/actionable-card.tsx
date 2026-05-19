import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CalendarIcon,
  CrosshairIcon,
  DollarSignIcon,
  HighlighterIcon,
  LightbulbIcon,
  MapPinIcon,
  MessageSquareIcon,
} from "lucide-react";
import type { FeedAction } from "../lib/feed-actions";

type Variant = "insight" | "anomaly";
type Severity = "low" | "medium" | "high";

interface ActionableCardProps {
  variant: Variant;
  severity?: Severity;
  title: string;
  description: string;
  actions: FeedAction[];
  /** Fired for non-ask actions. Route applies them to dashboard state. */
  onAction: (action: FeedAction) => void;
  /** Fired for `ask` actions. Route forwards the prompt to the chat drawer. */
  onAsk: (prompt: string) => void;
}

// Backgrounds are written as arbitrary 8-digit hex (e.g. `bg-[#eff6ff80]`)
// instead of Tailwind's `/N` alpha shorthand. Rationale: `bg-blue-50/50`
// compiles in Tailwind v4 to a pair — an sRGB hex fallback and a
// `@supports (color-mix)` override that re-mixes in oklab over the oklch
// palette token. Browsers that support `color-mix` (recent Chrome/Arc) take
// the oklab path; older embedded Chromiums (e.g. Cursor's built-in browser
// at the time of writing) fall through to the sRGB hex. Because oklab and
// sRGB interpolation produce visibly different tints — especially against
// the dark `--card` token — the same card ends up looking different in each
// browser. Pinning the colour to a literal hex (no `/N`, no @supports
// override) keeps all browsers on the same sRGB path and therefore the same
// visual result.
const INSIGHT_STYLES = {
  border: "border-blue-200 dark:border-blue-900",
  bg: "bg-[#eff6ff80] dark:bg-[#1624564d]",
  icon: "text-blue-500",
};

const ANOMALY_STYLES: Record<
  Severity,
  { border: string; bg: string; icon: string; badge: string }
> = {
  low: {
    border: "border-yellow-200 dark:border-yellow-900",
    bg: "bg-[#fefce880] dark:bg-[#4320044d]",
    icon: "text-yellow-500",
    badge:
      "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-400",
  },
  medium: {
    border: "border-orange-200 dark:border-orange-900",
    bg: "bg-[#fff7ed80] dark:bg-[#4413064d]",
    icon: "text-orange-500",
    badge:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400",
  },
  high: {
    border: "border-red-200 dark:border-red-900",
    bg: "bg-[#fef2f280] dark:bg-[#4608094d]",
    icon: "text-red-500",
    badge: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400",
  },
};

function iconForAction(kind: FeedAction["kind"]): React.ReactNode {
  const cls = "h-3 w-3";
  switch (kind) {
    case "filter_date":
      return <CalendarIcon className={cls} />;
    case "filter_zip":
      return <MapPinIcon className={cls} />;
    case "filter_fare":
      return <DollarSignIcon className={cls} />;
    case "highlight_period":
      return <HighlighterIcon className={cls} />;
    case "highlight_zone":
      return <MapPinIcon className={cls} />;
    case "focus_chart":
      return <CrosshairIcon className={cls} />;
    case "ask":
      return <MessageSquareIcon className={cls} />;
  }
}

/**
 * Action chip for a single feed suggestion. The chip's visual weight depends
 * on its kind: structural mutations (filter/highlight/focus) use the primary
 * tint, `ask` uses a neutral outline so the user can tell "this opens the
 * chat" from "this changes the dashboard" without reading the label.
 */
function ActionChip({
  action,
  onAction,
  onAsk,
}: {
  action: FeedAction;
  onAction: (a: FeedAction) => void;
  onAsk: (prompt: string) => void;
}) {
  const isAsk = action.kind === "ask";
  const isHighlight =
    action.kind === "highlight_period" || action.kind === "highlight_zone";

  return (
    <button
      type="button"
      onClick={() => {
        if (isAsk) onAsk(action.prompt);
        else onAction(action);
      }}
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${
        isAsk
          ? "border border-border bg-background text-foreground/80 hover:bg-muted hover:text-foreground"
          : isHighlight
            ? "bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
            : "bg-primary/10 text-primary hover:bg-primary/20"
      }`}
    >
      {iconForAction(action.kind)}
      <span>{action.label}</span>
      {isAsk && <ArrowRightIcon className="h-3 w-3 opacity-70" />}
    </button>
  );
}

export function ActionableCard({
  variant,
  severity,
  title,
  description,
  actions,
  onAction,
  onAsk,
}: ActionableCardProps) {
  const isAnomaly = variant === "anomaly";
  const styles = isAnomaly
    ? ANOMALY_STYLES[severity ?? "low"]
    : { ...INSIGHT_STYLES, badge: "" };

  return (
    <div className={`rounded-lg border ${styles.border} ${styles.bg} p-3`}>
      <div className="flex items-start gap-2 mb-2">
        {isAnomaly ? (
          <AlertTriangleIcon
            className={`h-4 w-4 ${styles.icon} mt-0.5 shrink-0`}
          />
        ) : (
          <LightbulbIcon className={`h-4 w-4 ${styles.icon} mt-0.5 shrink-0`} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="text-sm font-medium text-foreground leading-tight flex-1">
              {title}
            </p>
            {isAnomaly && severity && (
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${styles.badge}`}
              >
                {severity}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {description}
          </p>
        </div>
      </div>

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-6">
          {actions.map((action, i) => (
            <ActionChip
              key={`${action.kind}-${i}-${action.label}`}
              action={action}
              onAction={onAction}
              onAsk={onAsk}
            />
          ))}
        </div>
      )}
    </div>
  );
}

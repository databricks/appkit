import {
  Loader2Icon,
  type LucideIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import {
  type AggregatedResourceStatus,
  type ResourceSeverity,
  type ResourceStatus,
  useResourceStatus,
} from "./hooks/use-resource-status";
import { cn } from "./lib/utils";

/**
 * Per-kind UI overrides. Indicator authors register copy + an optional icon
 * for each resource kind they care about; the indicator falls back to a
 * generic "{kind} not ready" message for kinds that aren't registered.
 */
export interface ResourceKindRenderer {
  /** Title shown when this kind is the worst pending status. */
  title: (status: ResourceStatus) => string;
  /** Body copy shown when this kind is the worst pending status. */
  description: (
    status: ResourceStatus,
    aggregate: AggregatedResourceStatus,
  ) => string;
  /** Override the icon (defaults to a severity-appropriate icon). */
  icon?: LucideIcon;
}

export type ResourceStatusIndicatorPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

export interface ResourceStatusIndicatorProps {
  /** Restrict to a single resource kind. Otherwise shows the worst across all kinds. */
  kind?: string;
  /** Where to anchor the floating indicator. @default "bottom-right" */
  position?: ResourceStatusIndicatorPosition;
  /** Per-kind copy + icon overrides. */
  renderers?: Record<string, ResourceKindRenderer>;
  /** Additional class name applied to the wrapping element. */
  className?: string;
  /**
   * Where to mount the default floating card.
   *
   * - `undefined` (default): portal to `document.body` so `position: fixed`
   *   anchors to the viewport regardless of any ancestor that creates a
   *   containing block (`transform`, `filter`, `will-change`, `contain`, …)
   *   or stacking context. This is the recommended setup for any drop-in
   *   "global indicator" usage.
   * - `HTMLElement`: portal into a custom mount node (e.g. a Shadow-DOM
   *   root, or a specific layout slot).
   * - `null`: opt out of portaling — render inline at the mount location.
   *   Useful when you intentionally want the indicator to inherit a parent's
   *   stacking/transform context (rare).
   *
   * Ignored when `render` is provided — custom render output is always
   * placed inline at the mount location, since the consumer is already
   * taking responsibility for placement.
   */
  container?: HTMLElement | null;
  /**
   * Full custom render override. Receives the aggregate (already non-empty)
   * and returns the JSX to display. Use this when the default floating-card
   * UI doesn't fit your layout (e.g. a `Toaster` notification, an inline
   * banner, …).
   */
  render?: (aggregate: AggregatedResourceStatus) => React.ReactNode;
}

const POSITION_CLASSES: Record<ResourceStatusIndicatorPosition, string> = {
  "bottom-right": "bottom-4 right-4",
  "bottom-left": "bottom-4 left-4",
  "top-right": "top-4 right-4",
  "top-left": "top-4 left-4",
};

const SLIDE_IN_CLASS: Record<ResourceStatusIndicatorPosition, string> = {
  "bottom-right": "slide-in-from-bottom-2",
  "bottom-left": "slide-in-from-bottom-2",
  "top-right": "slide-in-from-top-2",
  "top-left": "slide-in-from-top-2",
};

const DEFAULT_KIND_RENDERERS: Record<string, ResourceKindRenderer> = {
  warehouse: {
    title: (s) =>
      s.severity === "error"
        ? "SQL warehouse unavailable"
        : "SQL warehouse warming up",
    description: (s, agg) => {
      if (s.severity === "error") {
        return (
          s.summary ??
          "The configured SQL warehouse is unavailable. Update DATABRICKS_WAREHOUSE_ID and reload."
        );
      }
      const labels = agg.affectedLabels.length;
      if (labels === 0) {
        return "Waiting for the warehouse to reach RUNNING.";
      }
      return `${labels} ${labels === 1 ? "query" : "queries"} waiting · ${formatElapsed(agg.elapsedMs)}`;
    },
  },
};

/**
 * Drop-in indicator that surfaces the worst pending {@link ResourceStatus}
 * across every plugin/component publishing into the nearest
 * {@link ResourceStatusProvider}.
 *
 * Renders nothing while the aggregate is empty (i.e. all resources ready).
 * Otherwise pops up as a small floating card anchored to a corner of the
 * viewport. Customize per-kind copy via `renderers`, or replace the entire
 * UI with `render`.
 *
 * @example
 * ```tsx
 * <ResourceStatusProvider>
 *   <ResourceStatusIndicator />
 *   <App />
 * </ResourceStatusProvider>
 * ```
 *
 * @example Custom render (e.g. a toaster notification)
 * ```tsx
 * <ResourceStatusIndicator
 *   render={(agg) => (
 *     <Toast variant={agg.worst?.severity === "error" ? "destructive" : "default"}>
 *       {agg.worst?.kind} {agg.worst?.state.toLowerCase()}
 *     </Toast>
 *   )}
 * />
 * ```
 */
export function ResourceStatusIndicator({
  kind,
  position = "bottom-right",
  renderers,
  className,
  container,
  render,
}: ResourceStatusIndicatorProps = {}) {
  const aggregate = useResourceStatus(kind ? { kind } : undefined);
  const worst = aggregate.worst;
  if (!worst) return null;

  if (render) return <>{render(aggregate)}</>;

  const merged = { ...DEFAULT_KIND_RENDERERS, ...renderers };
  const renderer = merged[worst.kind];
  const title = renderer?.title(worst) ?? defaultTitle(worst);
  const description =
    renderer?.description(worst, aggregate) ?? defaultDescription(worst);
  const Icon = renderer?.icon ?? iconForSeverity(worst.severity);
  const isError = worst.severity === "error";

  const card = (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      data-resource-kind={worst.kind}
      data-resource-state={worst.state}
      data-resource-severity={worst.severity}
      className={cn(
        "fixed z-50 flex items-start gap-3",
        "max-w-sm rounded-lg border bg-background p-3 shadow-lg",
        "animate-in fade-in",
        POSITION_CLASSES[position],
        SLIDE_IN_CLASS[position],
        isError
          ? "border-destructive/40 text-destructive"
          : "border-border text-foreground",
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          isError ? "text-destructive" : "animate-spin",
        )}
      />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium leading-none">{title}</span>
        <span className="text-xs text-muted-foreground truncate">
          {description}
        </span>
      </div>
    </div>
  );

  // Portal the default card so `position: fixed` anchors to the viewport
  // regardless of any ancestor that establishes a containing block
  // (`transform`, `filter`, `will-change`, `contain`, …) or a stacking
  // context. `container={null}` opts out; SSR falls back to inline render
  // since `document` is unavailable.
  const portalTarget =
    container === null
      ? null
      : (container ?? (typeof document !== "undefined" ? document.body : null));

  return portalTarget ? createPortal(card, portalTarget) : card;
}

function defaultTitle(status: ResourceStatus): string {
  switch (status.severity) {
    case "error":
      return `${humanizeKind(status.kind)} unavailable`;
    case "warning":
      return `${humanizeKind(status.kind)} degraded`;
    default:
      return `${humanizeKind(status.kind)} not ready`;
  }
}

function defaultDescription(status: ResourceStatus): string {
  if (status.summary) return status.summary;
  return `Current state: ${status.state}.`;
}

function iconForSeverity(severity: ResourceSeverity): LucideIcon {
  switch (severity) {
    case "error":
      return OctagonXIcon;
    case "warning":
      return TriangleAlertIcon;
    default:
      return Loader2Icon;
  }
}

function humanizeKind(kind: string): string {
  if (!kind) return "Resource";
  return kind
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

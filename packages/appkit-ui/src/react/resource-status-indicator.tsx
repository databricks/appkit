import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { type ToasterProps, toast } from "sonner";
import {
  type AggregatedResourceStatus,
  type ResourceStatus,
  useResourceStatus,
} from "./hooks/use-resource-status";
import { Toaster } from "./ui/sonner";

/** ~1Hz tick driving the elapsed-time display between store events. */
const ELAPSED_TICK_MS = 1000;

/** Per-kind copy + icon overrides for {@link ResourceStatusIndicator}. */
export interface ResourceKindRenderer {
  title: (status: ResourceStatus) => string;
  description: (
    status: ResourceStatus,
    aggregate: AggregatedResourceStatus,
  ) => string;
  /** Defaults to sonner's built-in loading/error icon. */
  icon?: LucideIcon;
}

/** Options shared by {@link ResourceStatusIndicator} and {@link useResourceStatusToaster}. */
export interface ResourceStatusToasterOptions {
  /** Restrict to a single resource kind. Otherwise shows the worst across all kinds. */
  kind?: string;
  /** Per-kind copy + icon overrides. */
  renderers?: Record<string, ResourceKindRenderer>;
  /** Class name applied to the toast (not the Toaster wrapper). */
  toastClassName?: string;
  /** Full custom render override, rendered inside `toast.custom`. */
  render?: (aggregate: AggregatedResourceStatus) => React.ReactNode;
}

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
        return `Waiting for the warehouse to reach RUNNING · ${formatElapsed(agg.elapsedMs)}`;
      }
      return `${labels} ${labels === 1 ? "query" : "queries"} waiting · ${formatElapsed(agg.elapsedMs)}`;
    },
  },
};

/**
 * Drives a sticky sonner toast that mirrors the worst pending resource
 * status. Does not render anything — supply your own `<Toaster />`. Most
 * apps should prefer {@link ResourceStatusIndicator}; use this hook only
 * to share an existing Toaster with unrelated app toasts.
 */
export function useResourceStatusToaster(
  options: ResourceStatusToasterOptions = {},
): void {
  const { kind, renderers, toastClassName, render } = options;
  const aggregate = useResourceStatus(kind ? { kind } : undefined);
  const worst = aggregate.worst;
  // Per-instance + per-kind toast id: instance scoping isolates multiple
  // indicators in the same tree; kind scoping forces dismiss-and-recreate
  // when severity flips between toast types (sonner can't morph
  // jsx/description cleanly across `custom` ↔ `loading`/`error`).
  const instanceId = useId();

  // The store is event-driven, so re-render at ~1Hz to keep the elapsed
  // counter advancing between status emissions.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!worst) return;
    const id = setInterval(() => forceTick((n) => n + 1), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [worst]);

  const liveIdRef = useRef<string | null>(null);

  // Runs every render: cheap because sonner patches the same id in place.
  useEffect(() => {
    if (!worst) {
      if (liveIdRef.current) {
        toast.dismiss(liveIdRef.current);
        liveIdRef.current = null;
      }
      return;
    }

    // Live elapsed; the snapshot only refreshes on store events.
    const liveAggregate: AggregatedResourceStatus = {
      ...aggregate,
      elapsedMs: Math.max(0, Date.now() - worst.startedAt),
    };

    const nextId = `appkit-resource:${instanceId}:${worst.kind}:${worst.severity}`;
    if (liveIdRef.current && liveIdRef.current !== nextId) {
      toast.dismiss(liveIdRef.current);
    }
    liveIdRef.current = nextId;

    if (render) {
      const node = render(liveAggregate);
      toast.custom(() => <>{node}</>, {
        id: nextId,
        duration: Number.POSITIVE_INFINITY,
        className: toastClassName,
      });
      return;
    }

    const merged = { ...DEFAULT_KIND_RENDERERS, ...renderers };
    const renderer = merged[worst.kind];
    const title = renderer?.title(worst) ?? defaultTitle(worst);
    const description =
      renderer?.description(worst, liveAggregate) ?? defaultDescription(worst);
    const Icon = renderer?.icon;
    const opts = {
      id: nextId,
      description,
      duration: Number.POSITIVE_INFINITY,
      className: toastClassName,
      ...(Icon ? { icon: <Icon className="size-4" /> } : {}),
    };

    if (worst.severity === "error") {
      toast.error(title, opts);
    } else {
      toast.loading(title, opts);
    }
  });

  // Dismiss on unmount so the toast doesn't outlive its mount point.
  useEffect(() => {
    return () => {
      if (liveIdRef.current) {
        toast.dismiss(liveIdRef.current);
        liveIdRef.current = null;
      }
    };
  }, []);
}

export interface ResourceStatusIndicatorProps
  extends ResourceStatusToasterOptions,
    Omit<ToasterProps, "className"> {
  /** Class name applied to the Toaster wrapper. */
  className?: string;
}

/**
 * Drop-in indicator that mounts a `<Toaster />` and surfaces the worst
 * pending {@link ResourceStatus} across every plugin/component publishing
 * into the nearest {@link ResourceStatusProvider} as a sonner toast
 * (`toast.loading` for cold starts, `toast.error` for unrecoverable
 * states), keyed by the worst kind so only one indicator toast is on
 * screen at a time.
 *
 * Forwards `Toaster` props (`position` defaults to `top-right`, plus
 * `theme`, `richColors`, …). Apps that already mount their own
 * `<Toaster />` should drop this component and call
 * {@link useResourceStatusToaster} instead.
 *
 * @example
 * ```tsx
 * <ResourceStatusProvider>
 *   <ResourceStatusIndicator />
 *   <App />
 * </ResourceStatusProvider>
 * ```
 *
 * @example Custom render
 * ```tsx
 * <ResourceStatusIndicator
 *   render={(agg) => (
 *     <div className="my-card">
 *       {agg.worst?.kind} {agg.worst?.state.toLowerCase()}
 *     </div>
 *   )}
 * />
 * ```
 */
export function ResourceStatusIndicator({
  kind,
  renderers,
  toastClassName,
  render,
  position = "top-right",
  ...toasterProps
}: ResourceStatusIndicatorProps = {}) {
  useResourceStatusToaster({ kind, renderers, toastClassName, render });
  return <Toaster position={position} {...toasterProps} />;
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
  return status.summary ?? `Current state: ${status.state}.`;
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

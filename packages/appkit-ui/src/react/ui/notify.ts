import type { ReactNode } from "react";
import { toast } from "sonner";

/** Options for a {@link notify} toast — a curated subset of sonner's surface. */
export interface NotifyOptions {
  /** Secondary line under the title. */
  description?: ReactNode;
  /** Auto-dismiss delay in ms. Omit for sonner's default; `Infinity` to make it sticky. */
  duration?: number;
}

/**
 * Fire a transient toast through the app's mounted `<Toaster />` — the same
 * sonner surface `ResourceStatusIndicator` renders warehouse-readiness into.
 *
 * This is a curated wrapper so app code never imports sonner directly: it
 * exposes only a title + `{ description, duration }`, not sonner's full option
 * bag. Requires a `<Toaster />` (or `<ResourceStatusIndicator />`) mounted in
 * the tree; without one the call is a no-op.
 *
 * @example
 * ```tsx
 * notify.message("Write back: Arr · Apr 2026 · $8,100,000");
 * notify.success("Saved", { description: "Row written back to the source." });
 * ```
 */
export const notify = {
  /** Neutral message toast. */
  message: (title: ReactNode, options?: NotifyOptions) =>
    toast(title, options),
  /** Informational toast. */
  info: (title: ReactNode, options?: NotifyOptions) => toast.info(title, options),
  /** Success toast. */
  success: (title: ReactNode, options?: NotifyOptions) =>
    toast.success(title, options),
  /** Warning toast. */
  warning: (title: ReactNode, options?: NotifyOptions) =>
    toast.warning(title, options),
  /** Error toast. */
  error: (title: ReactNode, options?: NotifyOptions) =>
    toast.error(title, options),
};

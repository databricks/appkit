import {
  BookmarkIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export interface SavedView {
  pngPath: string;
  metaPath: string;
  metadata: {
    name?: string;
    description?: string | null;
    filters?: Record<string, unknown>;
    highlights?: unknown[];
    savedAt?: string;
    savedBy?: string;
    pngPath?: string;
  };
}

interface SavedViewsPanelProps {
  /**
   * Send-to-chat callback. Clicking a saved view dispatches a load request
   * through the agent so the approval/action trail stays consistent.
   */
  onLoad: (view: SavedView) => void;
  /** Incrementing counter bumped by the route after each successful save. */
  refreshToken: number;
}

export function SavedViewsPanel({
  onLoad,
  refreshToken,
}: SavedViewsPanelProps) {
  const [open, setOpen] = useState(true);
  const [views, setViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/saved-views");
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${res.status}: ${txt}`);
      }
      const data = (await res.json()) as { views: SavedView[] };
      setViews(data.views);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount + whenever the parent bumps refreshToken. The dep on
  // refreshToken is intentional — biome flags it because it's an opaque
  // number with no direct read inside the effect body, but the whole
  // point is that changing it in the parent invalidates the cached list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    load();
  }, [load, refreshToken]);

  const toggle = () => setOpen((v) => !v);

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      {/*
        Header row is a flex container rather than a single big button so
        the refresh action can sit beside the collapse toggle without
        being nested inside it (`<button>` inside `<button>` is invalid
        HTML and trips React's hydration warning). The title area and the
        chevron each open/close the panel; refresh is its own button and
        no longer needs `e.stopPropagation`.
      */}
      <div className="w-full flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-2 text-left flex-1 min-w-0"
          aria-expanded={open}
          aria-label={open ? "Collapse saved views" : "Expand saved views"}
        >
          <BookmarkIcon className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">
            Saved views
          </span>
          <span className="text-xs text-muted-foreground">
            {views.length > 0 ? `(${views.length})` : ""}
          </span>
        </button>
        <div className="flex items-center gap-2">
          {loading && (
            <Loader2Icon className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
          )}
          {!loading && (
            <button
              type="button"
              onClick={load}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Refresh saved views"
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label={open ? "Collapse saved views" : "Expand saved views"}
            aria-expanded={open}
          >
            {open ? (
              <ChevronUpIcon className="h-4 w-4" />
            ) : (
              <ChevronDownIcon className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4">
          {error && (
            <div className="text-xs text-red-600 mb-2">
              Failed to load: {error}
            </div>
          )}

          {!error && views.length === 0 && !loading && (
            <div className="text-xs text-muted-foreground py-3">
              No saved views yet. Use the <em>Save view…</em> quick action or
              ask the agent to save the current configuration.
            </div>
          )}

          {views.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {views.map((view) => (
                <SavedViewCard
                  key={view.pngPath}
                  view={view}
                  onLoad={() => onLoad(view)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SavedViewCard({
  view,
  onLoad,
}: {
  view: SavedView;
  onLoad: () => void;
}) {
  const savedAt = view.metadata.savedAt
    ? new Date(view.metadata.savedAt).toLocaleString()
    : "";

  return (
    <button
      type="button"
      onClick={onLoad}
      className="shrink-0 w-56 rounded-lg border border-border bg-background hover:border-primary/40 hover:shadow-sm transition-all text-left overflow-hidden group"
    >
      <img
        src={`/api/dashboard/saved-view-png?path=${encodeURIComponent(view.pngPath)}`}
        alt={view.metadata.name ?? "saved view"}
        className="w-full h-24 object-cover bg-muted border-b border-border"
        loading="lazy"
      />
      <div className="p-2">
        <div className="text-xs font-medium text-foreground truncate">
          {view.metadata.name ?? "Untitled view"}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">
          {savedAt}
        </div>
      </div>
    </button>
  );
}

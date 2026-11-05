import { Component, type ReactNode, useLayoutEffect, useRef } from "react";

import { useDesignReady } from "./hooks/use-design-ready";
import { Skeleton } from "./ui/skeleton";

/** `?theme=dark|light`, else the system setting, applied before the first paint. */
function useDesignTheme() {
  useLayoutEffect(() => {
    const param = new URLSearchParams(location.search).get("theme");
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        param ? param === "dark" : !!media?.matches,
      );
    apply();
    if (param || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
}

/** The last good frame: the page's DOM, with chart canvases as pixels. */
interface Frame {
  nodes: Node[];
  pixels: HTMLCanvasElement[];
}

function capture(root: HTMLElement): Frame {
  return {
    nodes: Array.from(root.childNodes).map((n) => n.cloneNode(true)),
    pixels: Array.from(root.querySelectorAll("canvas")).map((c) => {
      const copy = document.createElement("canvas");
      copy.width = c.width;
      copy.height = c.height;
      // A canvas not laid out yet (0x0) can't be drawn from.
      if (c.width && c.height) copy.getContext("2d")?.drawImage(c, 0, 0);
      return copy;
    }),
  };
}

function restore(holder: HTMLElement | null, frame: Frame) {
  if (!holder) return;
  holder.replaceChildren(...frame.nodes.map((n) => n.cloneNode(true)));
  holder.querySelectorAll("canvas").forEach((c, i) => {
    const px = frame.pixels[i];
    if (!px?.width || !px.height) return;
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.drawImage(px, 0, 0);
  });
}

function HoldReady() {
  useDesignReady(false);
  return null;
}

interface LastGoodFrameProps {
  children: ReactNode;
  frame: { current: Frame | null };
  resetKey: unknown;
  onError?: (error: Error) => void;
  errorFallback: (error: Error) => ReactNode;
}

/** On a render error, shows the last good frame (or `errorFallback`) and holds readiness back. */
interface LastGoodFrameState {
  error: Error | null;
  resetKey: unknown;
}

class LastGoodFrame extends Component<LastGoodFrameProps, LastGoodFrameState> {
  state: LastGoodFrameState = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  // A new resetKey retries: render the children again.
  static getDerivedStateFromProps(
    props: LastGoodFrameProps,
    state: LastGoodFrameState,
  ): Partial<LastGoodFrameState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { error: null, resetKey: props.resetKey };
  }
  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const frame = this.props.frame.current;
    return (
      <>
        <HoldReady />
        {frame ? (
          <div
            data-design-last-good=""
            style={{ display: "contents" }}
            ref={(el) => restore(el, frame)}
          />
        ) : (
          <div data-design-error="" style={{ display: "contents" }}>
            {this.props.errorFallback(error)}
          </div>
        )}
      </>
    );
  }
}

const defaultErrorFallback = (error: Error) => (
  <pre className="text-destructive p-4 whitespace-pre-wrap">
    Design page failed to render: {error.message}
  </pre>
);

export interface DesignPageProps {
  children: ReactNode;
  /** Called with each render error the page hits. */
  onError?: (error: Error) => void;
  /** Changing it retries rendering after an error (e.g. after a hot update). */
  resetKey?: unknown;
  /** Shown for an error before anything rendered. Defaults to the message. */
  errorFallback?: (error: Error) => ReactNode;
}

/**
 * The shell the `design()` plugin renders every `/design` page in: the app's
 * theme from the first paint, and the last good frame instead of a broken one.
 */
export function DesignPage({
  children,
  onError,
  resetKey,
  errorFallback = defaultErrorFallback,
}: DesignPageProps) {
  useDesignTheme();
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<Frame | null>(null);
  // Hot updates re-render the page without this component: copy every frame.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // Only what the page rendered, not an error or a restored copy.
    const keep = () => {
      if (!el.querySelector("[data-design-last-good], [data-design-error]")) {
        frame.current = capture(el);
      }
    };
    // The first frame is already in place: no mutation reports it.
    if (el.childNodes.length > 0) keep();
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        keep();
      });
    });
    observer.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={root}
      data-design-page=""
      className="bg-background text-foreground min-h-screen"
    >
      <LastGoodFrame
        frame={frame}
        resetKey={resetKey}
        onError={onError}
        errorFallback={errorFallback}
      >
        {children}
      </LastGoodFrame>
    </div>
  );
}

export type DraftPlaceholderKind = "chart" | "table" | "card" | "generic";

/** Skeleton the `design()` plugin shows for a component a streaming draft hasn't defined yet. */
export function DraftPlaceholder({
  kind = "generic",
}: {
  kind?: DraftPlaceholderKind;
}) {
  if (kind === "chart") {
    return (
      <div
        data-draft-placeholder="chart"
        className="flex h-56 items-end gap-2 p-4"
      >
        {[40, 65, 50, 80, 60, 90, 70].map((h) => (
          <Skeleton key={h} className="flex-1" style={{ height: `${h}%` }} />
        ))}
      </div>
    );
  }
  if (kind === "table") {
    return (
      <div data-draft-placeholder="table" className="space-y-2 p-4">
        <Skeleton className="h-6 w-full" />
        {[0, 1, 2, 3].map((r) => (
          <Skeleton key={r} className="h-4 w-full opacity-70" />
        ))}
      </div>
    );
  }
  if (kind === "card") {
    return (
      <div
        data-draft-placeholder="card"
        className="space-y-3 rounded-xl border p-4"
      >
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  return (
    <div data-draft-placeholder="generic" className="space-y-2 p-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

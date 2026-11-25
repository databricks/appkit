import {
  Component,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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

function restore(holder: HTMLElement | null, frame: Frame | null) {
  if (!holder || !frame) return;
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

/**
 * Tracks whether the page itself is on screen (`shown`), and marks the shell
 * `data-design-rendered` while it is, from an effect after its first commit.
 */
function MarkRendered({
  shell,
  shown,
}: {
  shell: RefObject<HTMLElement | null>;
  shown: { current: boolean };
}) {
  const marked = useRef(false);
  useEffect(() => {
    marked.current = true;
    if (shown.current) shell.current?.setAttribute("data-design-rendered", "");
  }, [shell, shown]);
  // On screen from its commit (or a reveal after a Suspense fallback) until
  // the commit that hides or replaces it, which also takes the marker off: it
  // never shows beside an error, a copy or a fallback.
  useLayoutEffect(() => {
    shown.current = true;
    if (marked.current) shell.current?.setAttribute("data-design-rendered", "");
    return () => {
      shown.current = false;
      shell.current?.removeAttribute("data-design-rendered");
    };
  }, [shell, shown]);
  return null;
}

/** `errorFallback`'s output, or the message when that shows no text (`null`, `false`, `""`). */
function ShowError({
  error,
  fallback,
}: {
  error: Error;
  fallback: (error: Error) => ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  // For which error and fallback it came out empty (a retry can reuse this).
  const [blankFor, setBlankFor] = useState<unknown[]>([]);
  const blank = blankFor[0] === error && blankFor[1] === fallback;
  // Before the paint, so the empty node is never seen.
  useLayoutEffect(() => {
    if (!blank && !el.current?.textContent?.trim()) {
      setBlankFor([error, fallback]);
    }
  });
  return (
    <div ref={el} data-design-error="" style={{ display: "contents" }}>
      {blank ? defaultErrorFallback(error) : fallback(error)}
    </div>
  );
}

/** A thrown non-Error (a string, null) as an Error with its text. */
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

interface LastGoodFrameProps {
  children: ReactNode;
  frame: { current: Frame | null };
  shell: RefObject<HTMLElement | null>;
  shown: { current: boolean };
  /** Copies the page into `frame`, if it's on screen. */
  keep: () => void;
  resetKey: unknown;
  onError?: (error: Error) => void;
  errorFallback: (error: Error) => ReactNode;
  pendingFallback: ReactNode;
}

/** On a render error, shows the last good frame (or `errorFallback`) and holds readiness back. */
interface LastGoodFrameState {
  error: Error | null;
  resetKey: unknown;
}

class LastGoodFrame extends Component<LastGoodFrameProps, LastGoodFrameState> {
  state: LastGoodFrameState = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error: unknown) {
    return { error: asError(error) };
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
  componentDidCatch(error: unknown) {
    this.props.onError?.(asError(error));
  }
  // Just before an error replaces the page: copy it as it is on screen now
  // (it may have committed in this same task, after the last copy).
  getSnapshotBeforeUpdate(_: LastGoodFrameProps, prev: LastGoodFrameState) {
    if (this.state.error && !prev.error) this.props.keep();
    return null;
  }
  componentDidUpdate() {}
  render() {
    const { error } = this.state;
    if (!error) {
      // Inside the boundary: while the page suspends, it isn't rendered yet.
      return (
        <Suspense fallback={this.props.pendingFallback}>
          {this.props.children}
          <MarkRendered shell={this.props.shell} shown={this.props.shown} />
        </Suspense>
      );
    }
    // A page on screen now is copied before this commit (above).
    const lastGood =
      this.props.frame.current !== null || this.props.shown.current;
    return (
      <>
        <HoldReady />
        {lastGood ? (
          <div
            data-design-last-good=""
            style={{ display: "contents" }}
            ref={(el) => restore(el, this.props.frame.current)}
          />
        ) : (
          <ShowError error={error} fallback={this.props.errorFallback} />
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
  /** Shown for an error before anything rendered. Defaults to (and, when it shows no text, falls back to) the message. */
  errorFallback?: (error: Error) => ReactNode;
  /** Shown while the page suspends (lazy code, data). Defaults to nothing. */
  pendingFallback?: ReactNode;
}

/**
 * The shell the `design()` plugin renders every `/design` page in: the app's
 * theme from the first paint, and the last good frame instead of a broken one.
 *
 * Its state, for a builder to read from the DOM (one at a time):
 * - pending: no `[data-design-page]` shell yet (the page hasn't loaded; for a
 *   streamed draft, no version is published yet), or a shell with none of the
 *   markers below while the page suspends (`pendingFallback` on screen).
 * - rendered: `[data-design-page][data-design-rendered]`, set after the page
 *   commits a render without an error. An empty page counts: that's its output.
 * - last-good: `[data-design-last-good]` in the shell, after a render error
 *   once the page has shown: a copy of it as it was on screen when the error
 *   came (or, if a Suspense fallback had replaced it, as it last showed). No
 *   `data-design-rendered`.
 * - error: `[data-design-error]` in the shell, with the message (or
 *   `errorFallback`), for a render error before any good render (or a streamed
 *   draft that fails to load). No `data-design-rendered`.
 *
 * `data-design-rendered` goes in the same commit an error (or a Suspense
 * fallback) replaces the page, so a MutationObserver never sees it beside
 * `last-good` or `error`.
 */
export function DesignPage({
  children,
  onError,
  resetKey,
  errorFallback = defaultErrorFallback,
  pendingFallback = null,
}: DesignPageProps) {
  useDesignTheme();
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<Frame | null>(null);
  // The page itself is on screen: not an error, a copy, or a Suspense fallback.
  const shown = useRef(false);
  const keep = useCallback(() => {
    if (shown.current && root.current) frame.current = capture(root.current);
  }, []);
  // Hot updates re-render the page without this component: copy every frame,
  // after each change (not on an animation frame: a hidden frame gets none).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // The first frame is already in place: no mutation reports it.
    keep();
    const observer = new MutationObserver(keep);
    observer.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    return () => observer.disconnect();
  }, [keep]);
  return (
    <div
      ref={root}
      data-design-page=""
      className="bg-background text-foreground min-h-screen"
    >
      <LastGoodFrame
        frame={frame}
        shell={root}
        shown={shown}
        keep={keep}
        resetKey={resetKey}
        onError={onError}
        errorFallback={errorFallback}
        pendingFallback={pendingFallback}
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

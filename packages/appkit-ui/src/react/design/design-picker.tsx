import { MousePointerClick, Send, X } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Textarea } from "../ui/textarea";
import {
  captureElement,
  type DesignElementInfo,
  inspectElement,
} from "./inspect";
import {
  DESIGN_SELECTION_MESSAGE,
  type DesignSelectionMessage,
  postDesignSelection,
} from "./message";

/** Endpoints the `design()` plugin mounts in development. */
const SELECTION_ENDPOINT = "/api/design/selection";
const SCREENSHOT_ENDPOINT = "/api/design/screenshots";
const ROOT_ID = "appkit-design-picker";

type Status = "idle" | "sending" | "sent-builder" | "sent-file" | "error";

interface Picked {
  el: Element;
  info: DesignElementInfo;
}

/** Props for {@link DesignPicker}. */
export interface DesignPickerProps {
  /** Whether clicks select elements. */
  active: boolean;
  onActiveChange: (active: boolean) => void;
  /** Origins an embedding app builder may be on (the plugin's `builderOrigin`). */
  builderOrigins?: string[];
}

function Outline({
  el,
  style,
  label,
}: {
  el: Element;
  style: CSSProperties;
  label?: number;
}) {
  const r = el.getBoundingClientRect();
  return (
    <div
      className="pointer-events-none fixed rounded-sm"
      style={{
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        ...style,
      }}
    >
      {label !== undefined && (
        <span className="bg-primary text-primary-foreground absolute -top-2.5 -left-2.5 flex size-5 items-center justify-center rounded-full text-[10px] font-semibold shadow">
          {label}
        </span>
      )}
    </div>
  );
}

/**
 * Keeps design chrome (picker, canvas header) usable while a modal dialog is
 * open. Modals set `pointer-events: none` on <body>, dismiss on any outside
 * press and trap focus; the chrome sits outside the dialog, so it must not
 * count as "outside" and must be able to take focus (e.g. the note box).
 * Pair it with `pointer-events-auto` and a z-index above the modal overlay.
 *
 * @internal
 */
export function useAboveModals(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const stop = (e: Event) => e.stopPropagation();
    const PRESS = ["pointerdown", "mousedown", "focusin", "touchstart"];
    for (const t of PRESS) root.addEventListener(t, stop);
    // Focus traps watch `focusout` on the document and pull focus back when
    // it leaves the dialog; let it move into the chrome.
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) {
        e.stopPropagation();
      }
    };
    window.addEventListener("focusout", onFocusOut, true);
    return () => {
      for (const t of PRESS) root.removeEventListener(t, stop);
      window.removeEventListener("focusout", onFocusOut, true);
    };
  }, [ref]);
}

const HOVER_STYLE: CSSProperties = {
  outline: "2px dashed var(--primary)",
  outlineOffset: 2,
};
const SELECTED_STYLE: CSSProperties = {
  outline: "2px solid var(--primary)",
  outlineOffset: 2,
  background: "color-mix(in oklch, var(--primary) 10%, transparent)",
};

/**
 * Click-to-select overlay and send panel of the design canvas. While
 * `active`, clicks select or deselect elements (Escape stops). Sends are
 * persisted by the `design()` plugin and, when the canvas is embedded by an
 * allowed app builder, posted to it as a {@link DesignSelectionMessage}.
 *
 * Rendered by {@link DesignCanvas}; you don't mount it yourself.
 */
export function DesignPicker({
  active,
  onActiveChange,
  builderOrigins = [],
}: DesignPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Element | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  // Outlines are positioned from live rects; re-render when the page moves.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    window.addEventListener("scroll", rerender, true);
    window.addEventListener("resize", rerender);
    return () => {
      window.removeEventListener("scroll", rerender, true);
      window.removeEventListener("resize", rerender);
    };
  }, []);

  useAboveModals(rootRef);

  useEffect(() => {
    if (!active) return;
    const own = (t: EventTarget | null) =>
      !(t instanceof Element) ||
      !!t.closest(`#${ROOT_ID}, [data-design-chrome]`);
    const onMove = (e: MouseEvent) =>
      setHovered(own(e.target) ? null : (e.target as Element));
    const onClick = (e: MouseEvent) => {
      if (own(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as Element;
      setStatus("idle");
      setPicked((prev) =>
        prev.some((p) => p.el === el)
          ? prev.filter((p) => p.el !== el)
          : [...prev, { el, info: inspectElement(el) }],
      );
    };
    // A pick mustn't act on the page either: e.g. a pointerdown would let an
    // open dialog dismiss itself before the click selects its content.
    const swallow = (e: Event) => {
      if (own(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && onActiveChange(false);
    const PRESS = ["pointerdown", "mousedown", "pointerup", "mouseup"];
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    for (const t of PRESS) window.addEventListener(t, swallow, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      for (const t of PRESS) window.removeEventListener(t, swallow, true);
      setHovered(null);
    };
  }, [active, onActiveChange]);

  // Stop selecting once a send leaves nothing selected. An effect, because
  // updating the canvas's state from inside our own state updater is a
  // render-phase update React warns about.
  const sent = status === "sent-builder" || status === "sent-file";
  useEffect(() => {
    if (sent && picked.length === 0) onActiveChange(false);
  }, [sent, picked.length, onActiveChange]);

  async function send() {
    setStatus("sending");
    // Picks and the note can change while the request is in flight; only
    // what was actually sent is cleared afterwards.
    const sending = picked;
    const sentNote = note.trim() || undefined;
    try {
      const elements = await Promise.all(
        sending.map(async ({ el, info }) => ({
          ...info,
          screenshot: await captureElement(el),
        })),
      );
      const res = await fetch(SELECTION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elements,
          note: sentNote,
          url: location.pathname,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { selection } = (await res.json()) as {
        selection?: { id: string; elements: { screenshot?: string }[] };
      };

      const message: DesignSelectionMessage = {
        type: DESIGN_SELECTION_MESSAGE,
        version: 1,
        id: selection?.id,
        url: location.pathname,
        ...(sentNote ? { note: sentNote } : {}),
        selections: elements.map((el, i) => {
          const saved = selection?.elements[i]?.screenshot;
          return saved
            ? {
                ...el,
                screenshotUrl: `${location.origin}${SCREENSHOT_ENDPOINT}/${saved.split("/").pop()}`,
              }
            : el;
        }),
      };
      const posted = postDesignSelection(message, builderOrigins);

      setPicked((prev) => prev.filter((p) => !sending.includes(p)));
      setNote((n) => (n.trim() === (sentNote ?? "") ? "" : n));
      setStatus(posted ? "sent-builder" : "sent-file");
    } catch {
      setStatus("error");
    }
  }

  const showPanel = active || picked.length > 0 || status !== "idle";

  return (
    <div
      ref={rootRef}
      id={ROOT_ID}
      className="pointer-events-auto relative z-[2147483647]"
    >
      {active && hovered && <Outline el={hovered} style={HOVER_STYLE} />}
      {picked.map((p, i) => (
        <Outline key={i} el={p.el} style={SELECTED_STYLE} label={i + 1} />
      ))}
      {showPanel && (
        <Card className="fixed right-6 bottom-6 w-[22rem] gap-4 py-4 shadow-lg">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">
              {picked.length > 0
                ? `${picked.length} selected`
                : active
                  ? "Selecting"
                  : "Selection"}
            </CardTitle>
            <CardDescription className="text-xs">
              {active
                ? "Click elements to add or remove them. Esc to stop."
                : "Turn on Select to pick more elements."}
            </CardDescription>
            {picked.length > 0 && (
              <CardAction>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPicked([])}
                  disabled={status === "sending"}
                >
                  Clear
                </Button>
              </CardAction>
            )}
          </CardHeader>

          {picked.length > 0 && (
            <CardContent className="flex flex-col gap-3 px-4">
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                {picked.map((p, i) => (
                  <li
                    key={i}
                    className="hover:bg-muted flex items-center gap-2 rounded-md px-1.5 py-1"
                  >
                    <span className="bg-primary text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">
                          {p.info.component ?? `<${p.info.tag}>`}
                        </span>
                        <Badge
                          variant="secondary"
                          className="px-1.5 py-0 font-mono text-[10px]"
                        >
                          {p.info.tag}
                        </Badge>
                      </div>
                      <div className="text-muted-foreground truncate font-mono text-[11px]">
                        {p.info.source ?? "no source location"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label="Remove"
                      onClick={() =>
                        setPicked((prev) => prev.filter((x) => x.el !== p.el))
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Textarea
                placeholder="What should change? (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="resize-none text-sm"
              />
            </CardContent>
          )}

          <CardFooter className="flex-col items-stretch gap-2 px-4">
            {picked.length > 0 ? (
              <Button disabled={status === "sending"} onClick={send}>
                <Send className="size-4" />
                {status === "sending"
                  ? "Sending…"
                  : `Send ${picked.length} to agent`}
              </Button>
            ) : (
              active && (
                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                  <MousePointerClick className="size-4" />
                  Nothing selected yet
                </div>
              )
            )}
            {status === "sent-builder" && (
              <p className="text-xs">Sent to the app builder.</p>
            )}
            {status === "sent-file" && (
              <p className="text-xs">
                Saved to <code>.appkit/design-selection.json</code>. Ask your
                agent to apply it.
              </p>
            )}
            {status === "error" && (
              <p className="text-destructive text-xs">
                Couldn't send. Is the design() plugin registered?
              </p>
            )}
          </CardFooter>
        </Card>
      )}
    </div>
  );
}

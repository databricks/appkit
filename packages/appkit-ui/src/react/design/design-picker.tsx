import { type CSSProperties, useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  captureElement,
  type DesignElementInfo,
  inspectElement,
} from "./inspect";

/** Endpoint the `design()` plugin mounts in development. */
const SELECTION_ENDPOINT = "/api/design/selection";
const ROOT_ID = "appkit-design-picker";
/** Same violet as the `<Variants>` picker, so dev chrome reads as dev chrome. */
const ACCENT = "#8b5cf6";

type Status = "idle" | "sending" | "sent" | "error";

interface Picked {
  el: Element;
  info: DesignElementInfo;
}

function box(el: Element, style: CSSProperties, key?: number) {
  const r = el.getBoundingClientRect();
  return (
    <div
      key={key}
      style={{
        position: "fixed",
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        pointerEvents: "none",
        borderRadius: 2,
        ...style,
      }}
    />
  );
}

const panel: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 64,
  width: 320,
  maxHeight: "60vh",
  overflow: "auto",
  background: "#fff",
  color: "#111",
  border: `1px solid ${ACCENT}`,
  borderRadius: 8,
  padding: 12,
  font: "12px/1.4 system-ui, sans-serif",
  boxShadow: "0 8px 24px rgba(0,0,0,.18)",
};

const button: CSSProperties = {
  background: ACCENT,
  color: "#fff",
  border: 0,
  borderRadius: 6,
  padding: "6px 12px",
  font: "600 12px system-ui, sans-serif",
  cursor: "pointer",
};

/**
 * Dev-only click-to-select overlay. Toggle it with the floating button (or
 * Escape to stop), click elements to add/remove them, add a note, and send the
 * selection to the `design()` plugin for the coding agent to pick up.
 *
 * Injected into every page by the design plugin's dev server; you don't
 * render it yourself.
 */
export function DesignPicker() {
  const [active, setActive] = useState(false);
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

  useEffect(() => {
    if (!active) return;
    const own = (t: EventTarget | null) =>
      !(t instanceof Element) || !!t.closest(`#${ROOT_ID}`);
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setActive(false);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      setHovered(null);
    };
  }, [active]);

  async function send() {
    setStatus("sending");
    try {
      const elements = await Promise.all(
        picked.map(async ({ el, info }) => ({
          ...info,
          screenshot: await captureElement(el),
        })),
      );
      const res = await fetch(SELECTION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elements,
          note: note.trim() || undefined,
          url: location.pathname,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setPicked([]);
      setNote("");
      setActive(false);
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  return (
    <>
      {active && hovered && box(hovered, { outline: `2px dashed ${ACCENT}` })}
      {picked.map((p, i) =>
        box(
          p.el,
          { outline: `2px solid ${ACCENT}`, background: `${ACCENT}22` },
          i,
        ),
      )}
      {(picked.length > 0 || status !== "idle") && (
        <div style={panel}>
          {picked.map((p, i) => (
            <div
              key={`${p.info.source}-${i}`}
              style={{ display: "flex", gap: 8, marginBottom: 6 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{p.info.component ?? `<${p.info.tag}>`}</strong>
                <div style={{ color: "#666", wordBreak: "break-all" }}>
                  {p.info.source ?? "no source location"}
                </div>
              </div>
              <button
                type="button"
                aria-label="Remove"
                style={{ ...button, background: "transparent", color: "#666" }}
                onClick={() =>
                  setPicked((prev) => prev.filter((x) => x.el !== p.el))
                }
              >
                ×
              </button>
            </div>
          ))}
          {picked.length > 0 && (
            <>
              <textarea
                placeholder="Note for the agent (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  margin: "6px 0",
                }}
              />
              <button
                type="button"
                style={button}
                disabled={status === "sending"}
                onClick={send}
              >
                {status === "sending"
                  ? "Sending…"
                  : `Send ${picked.length} to agent`}
              </button>
            </>
          )}
          {status === "sent" && <div>Sent. Ask your agent to apply it.</div>}
          {status === "error" && (
            <div style={{ color: "#b91c1c" }}>
              Couldn't send. Is the design() plugin registered?
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        style={{ ...button, position: "fixed", right: 16, bottom: 16 }}
        aria-pressed={active}
        onClick={() => setActive((a) => !a)}
      >
        {active ? "Selecting… (Esc)" : "Select"}
      </button>
    </>
  );
}

/** Mounts {@link DesignPicker} into its own root on `document.body`, once. */
export function mountDesignPicker() {
  if (document.getElementById(ROOT_ID)) return;
  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.style.cssText = "position:relative;z-index:2147483647";
  document.body.appendChild(host);
  createRoot(host).render(<DesignPicker />);
}

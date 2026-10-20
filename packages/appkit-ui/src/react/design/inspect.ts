/** What the picker records for one selected DOM element. */
export interface DesignElementInfo {
  /** Nearest React component owning the element. */
  component?: string;
  /** Owning components, innermost first (up to {@link STACK_DEPTH}). */
  stack?: string[];
  /** `file:line:col` injected by AppKit's dev-server `data-source` transform. */
  source?: string;
  /** Serialized props of {@link component}. */
  props?: Record<string, unknown>;
  tag: string;
  text?: string;
}

const STACK_DEPTH = 6;

interface Fiber {
  type: unknown;
  return: Fiber | null;
  memoizedProps?: Record<string, unknown>;
}

type ComponentType = {
  displayName?: string;
  name?: string;
  render?: { name?: string };
  type?: { name?: string };
};

function fiberOf(el: Element): Fiber | undefined {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  return key ? (el as unknown as Record<string, Fiber>)[key] : undefined;
}

/** Name of a function / memo / forwardRef component fiber, else undefined. */
function componentName(type: unknown): string | undefined {
  if (!type || (typeof type !== "function" && typeof type !== "object")) {
    return undefined;
  }
  const t = type as ComponentType;
  if (typeof type === "object" && !t.render && !t.type) return undefined;
  return (
    t.displayName || t.name || t.render?.name || t.type?.name || "Anonymous"
  );
}

/** JSON-safe, size-bounded copy of component props (children dropped). */
function serializeProps(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return String(value);
  if ("$$typeof" in value) return "[element]";
  if (depth >= 3) return "[…]";
  if (Array.isArray(value))
    return value.slice(0, 20).map((v) => serializeProps(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "children") continue;
    out[k] = serializeProps(v, depth + 1);
  }
  return out;
}

export function inspectElement(el: Element): DesignElementInfo {
  const stack: string[] = [];
  let props: Record<string, unknown> | undefined;
  for (let f = fiberOf(el) ?? null; f && stack.length < STACK_DEPTH;) {
    const name = componentName(f.type);
    if (name) {
      if (stack.length === 0) {
        props = serializeProps(f.memoizedProps ?? {}) as Record<
          string,
          unknown
        >;
      }
      stack.push(name);
    }
    f = f.return;
  }
  const text = el.textContent?.trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    component: stack[0],
    ...(stack.length ? { stack } : {}),
    source:
      el.closest("[data-source]")?.getAttribute("data-source") ?? undefined,
    ...(props ? { props } : {}),
    tag: el.tagName.toLowerCase(),
    ...(text ? { text } : {}),
  };
}

function inlineStyles(src: Element, dst: Element) {
  const cs = getComputedStyle(src);
  let css = "";
  for (let i = 0; i < cs.length; i++) {
    css += `${cs[i]}:${cs.getPropertyValue(cs[i])};`;
  }
  dst.setAttribute("style", css);
  for (let i = 0; i < src.children.length; i++) {
    inlineStyles(src.children[i], dst.children[i]);
  }
}

/**
 * Rasterizes an element via an SVG `<foreignObject>` with inlined computed
 * styles, as a JPEG data URL. Best-effort: returns undefined when the browser
 * refuses (e.g. cross-origin images taint the canvas).
 */
// ponytail: no external images/fonts are embedded; add html-to-image if screenshots need pixel fidelity
export async function captureElement(
  el: Element,
  maxWidth = 800,
): Promise<string | undefined> {
  try {
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return undefined;
    const clone = el.cloneNode(true) as Element;
    inlineStyles(el, clone);
    const xml = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const scale =
      Math.min(1, maxWidth / width) * (window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return undefined;
  }
}

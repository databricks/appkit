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
  tag: number;
  type: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  stateNode: unknown;
  memoizedProps?: Record<string, unknown>;
}

const HOST_ROOT = 3;

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

/**
 * The element's fiber and its ancestors, innermost first, each resolved to its
 * *current* (committed) version. The DOM-attached fiber and its `return` links
 * can belong to the previous render, whose props are stale; the current tree
 * is the one reachable through `child` links from the root's `current`.
 */
function currentChain(el: Element): Fiber[] {
  const chain: Fiber[] = [];
  for (let f = fiberOf(el) ?? null; f; f = f.return) chain.push(f);
  const root = chain[chain.length - 1];
  if (root?.tag !== HOST_ROOT) return chain;
  let cur = (root.stateNode as { current: Fiber }).current;
  const resolved = [cur];
  for (let i = chain.length - 2; i >= 0; i--) {
    const want = chain[i];
    let c = cur.child;
    while (c && c !== want && c.alternate !== want) c = c.sibling;
    if (!c) return chain;
    cur = c;
    resolved.push(c);
  }
  return resolved.reverse();
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
  const chain = currentChain(el);
  const stack: string[] = [];
  let props: Record<string, unknown> | undefined;
  let source: string | undefined;
  for (const f of chain) {
    // Native elements carry `data-source`; component call sites (including
    // library components that never reach the DOM) carry `data-appkit-source`.
    const loc =
      f.memoizedProps?.["data-source"] ??
      f.memoizedProps?.["data-appkit-source"];
    if (!source && typeof loc === "string") source = loc;
    const name = componentName(f.type);
    if (!name || stack.length >= STACK_DEPTH) continue;
    if (stack.length === 0) {
      props = serializeProps(f.memoizedProps ?? {}) as Record<string, unknown>;
      delete props["data-appkit-source"];
    }
    stack.push(name);
  }
  source ??=
    el.closest("[data-source]")?.getAttribute("data-source") ?? undefined;
  const text = el.textContent?.trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    component: stack[0],
    ...(stack.length ? { stack } : {}),
    ...(source ? { source } : {}),
    ...(props ? { props } : {}),
    tag: el.tagName.toLowerCase(),
    ...(text ? { text } : {}),
  };
}

async function toDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Copies computed styles onto the clone and embeds what an SVG image can't
 * load by itself: canvas pixels, `<img>` sources and CSS background images
 * (as data URLs). Resources that can't be fetched (CORS) are left as-is.
 */
function prepareClone(src: Element, dst: Element, tasks: Promise<unknown>[]) {
  const cs = getComputedStyle(src);
  let css = "";
  for (let i = 0; i < cs.length; i++) {
    css += `${cs[i]}:${cs.getPropertyValue(cs[i])};`;
  }
  dst.setAttribute("style", css);

  // Live form state lives in DOM properties, which serialization drops.
  if (src instanceof HTMLInputElement) {
    if (src.type === "checkbox" || src.type === "radio") {
      dst.toggleAttribute("checked", src.checked);
    } else {
      dst.setAttribute("value", src.value);
    }
  } else if (src instanceof HTMLTextAreaElement) {
    dst.textContent = src.value;
  } else if (src instanceof HTMLSelectElement) {
    dst.querySelectorAll("option").forEach((o, i) => {
      o.toggleAttribute("selected", src.options[i]?.selected ?? false);
    });
  }

  if (src instanceof HTMLCanvasElement) {
    try {
      const img = document.createElement("img");
      img.setAttribute("style", css);
      img.src = src.toDataURL();
      dst.replaceWith(img);
    } catch {
      // tainted canvas: keep the empty clone
    }
    return;
  }
  if (src instanceof HTMLImageElement && src.currentSrc) {
    dst.removeAttribute("srcset");
    tasks.push(
      toDataUrl(src.currentSrc)
        .then((u) => dst.setAttribute("src", u))
        .catch(() => {}),
    );
  }
  const bg = cs.getPropertyValue("background-image");
  const urls = [...bg.matchAll(/url\("?([^")]+)"?\)/g)].map((m) => m[1]);
  if (urls.length) {
    tasks.push(
      Promise.all(urls.map((u) => toDataUrl(u).catch(() => u))).then((data) => {
        let out = bg;
        urls.forEach((u, i) => {
          out = out.replace(u, data[i]);
        });
        (dst as HTMLElement).style.setProperty("background-image", out);
      }),
    );
  }
  for (let i = 0; i < src.children.length; i++) {
    prepareClone(src.children[i], dst.children[i], tasks);
  }
}

const ROOT_RESET: Record<string, string> = {
  position: "relative",
  inset: "auto",
  margin: "0",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
};

/**
 * Rasterizes an element via an SVG `<foreignObject>` with inlined computed
 * styles, as a JPEG data URL. Best-effort: returns undefined when the browser
 * refuses to rasterize.
 */
// ponytail: web fonts and cross-origin resources without CORS aren't embedded; add html-to-image if that matters
export async function captureElement(
  el: Element,
  maxWidth = 800,
): Promise<string | undefined> {
  // A shape inside an icon (`<path>`, `<circle>`, ...) only renders inside
  // its <svg>, so capture the whole icon.
  if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) {
    el = el.ownerSVGElement ?? el;
  }
  try {
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return undefined;
    const clone = el.cloneNode(true) as Element;
    // A parent so the root itself can be swapped (a selected <canvas>).
    const wrap = document.createElement("div");
    wrap.appendChild(clone);
    const tasks: Promise<unknown>[] = [];
    prepareClone(el, clone, tasks);
    await Promise.all(tasks);
    // The crop is the element's own box, so its placement in the page
    // (absolute/fixed offsets, margins, transforms) must not move it out.
    const root = wrap.firstElementChild as HTMLElement | null;
    if (root) {
      for (const [prop, value] of Object.entries(ROOT_RESET)) {
        root.style.setProperty(prop, value);
      }
    }
    const xml = new XMLSerializer().serializeToString(wrap);
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

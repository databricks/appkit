import { useEffect, useRef } from "react";
import { describeElement } from "../lib/dom-utils";
import type { ElementDescription } from "../lib/dom-utils";

interface Props {
  active: boolean;
  shadowRoot: ShadowRoot;
  onPick: (element: ElementDescription) => void;
  onCancel: () => void;
}

function getReactFiberQuick(element: Element): any | null {
  const keys = Object.keys(element);
  for (const key of keys) {
    if (
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$")
    ) {
      return (element as any)[key];
    }
  }
  return null;
}

interface QuickInfo {
  name?: string;
  file?: string;
  line?: number;
}

function extractSourceFromDebugInfo(
  debugInfo: any[],
): { fileName: string; lineNumber: number } | null {
  for (const entry of debugInfo) {
    if (entry.fileName && entry.lineNumber) {
      return { fileName: entry.fileName, lineNumber: entry.lineNumber };
    }
    if (entry.env) continue;
    if (entry.stack) {
      const match = String(entry.stack).match(/\((.+?):(\d+):\d+\)/);
      if (match) return { fileName: match[1], lineNumber: Number(match[2]) };
    }
  }
  return null;
}

function parseStackTrace(
  stack: string,
): { fileName: string; lineNumber: number } | null {
  const lines = stack.split("\n");
  for (const line of lines) {
    const match = line.match(/(?:at .+? \(|@)(.+?):(\d+)(?::\d+)?\)?/);
    if (
      match &&
      !match[1].includes("node_modules") &&
      !match[1].includes("react")
    ) {
      return { fileName: match[1], lineNumber: Number(match[2]) };
    }
  }
  return null;
}

function extractSource(
  fiber: any,
): { fileName: string; lineNumber: number } | null {
  if (fiber._debugSource?.fileName && fiber._debugSource?.lineNumber) {
    return fiber._debugSource;
  }

  if (Array.isArray(fiber._debugInfo)) {
    const info = extractSourceFromDebugInfo(fiber._debugInfo);
    if (info) return info;
  }

  if (typeof fiber._debugStack === "string") {
    const parsed = parseStackTrace(fiber._debugStack);
    if (parsed) return parsed;
  }

  if (fiber._debugOwner) {
    if (
      fiber._debugOwner._debugSource?.fileName &&
      fiber._debugOwner._debugSource?.lineNumber
    ) {
      return fiber._debugOwner._debugSource;
    }
    if (Array.isArray(fiber._debugOwner._debugInfo)) {
      const info = extractSourceFromDebugInfo(fiber._debugOwner._debugInfo);
      if (info) return info;
    }
    if (typeof fiber._debugOwner._debugStack === "string") {
      const parsed = parseStackTrace(fiber._debugOwner._debugStack);
      if (parsed) return parsed;
    }
  }

  return null;
}

let lastLoggedElement: Element | null = null;

function getQuickComponentInfo(element: Element): QuickInfo | null {
  let fiber = getReactFiberQuick(element);
  if (!fiber) return null;

  if (element !== lastLoggedElement) {
    lastLoggedElement = element;
    const debugKeys: string[] = [];
    let f = fiber;
    while (f && debugKeys.length < 3) {
      const fiberKeys = Object.keys(f).filter((k) => k.startsWith("_debug"));
      const name =
        f.type && typeof f.type !== "string"
          ? f.type.displayName || f.type.name
          : undefined;
      if (fiberKeys.length > 0 || name) {
        debugKeys.push(`[${name || f.tag}] ${fiberKeys.join(", ")}`);
      }
      f = f.return;
    }
    console.debug("[appkit-devtools] Fiber debug props:", debugKeys);
  }

  let firstName: string | undefined;

  while (fiber) {
    const type = fiber.type;
    const name =
      type && typeof type !== "string"
        ? type.displayName || type.name || undefined
        : undefined;

    if (!firstName && name) firstName = name;

    const source = extractSource(fiber);
    if (source) {
      const shortFile = source.fileName.replace(/^.*[/\\]/, "");
      return {
        name: firstName || name,
        file: shortFile,
        line: source.lineNumber,
      };
    }

    fiber = fiber.return;
  }

  if (firstName) return { name: firstName };
  return null;
}

export function ElementPicker({ active, shadowRoot, onPick, onCancel }: Props) {
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const componentMapRef = useRef<
    Record<string, { file: string; line: number }>
  >({});

  useEffect(() => {
    if (!highlightRef.current) {
      const el = document.createElement("div");
      el.className = "pick-highlight";
      el.style.display = "none";
      shadowRoot.appendChild(el);
      highlightRef.current = el;
    }
    if (!labelRef.current) {
      const el = document.createElement("div");
      el.className = "pick-label";
      el.style.display = "none";
      shadowRoot.appendChild(el);
      labelRef.current = el;
    }
    hostRef.current = shadowRoot.host as HTMLElement;
  }, [shadowRoot]);

  useEffect(() => {
    if (!active) return;
    fetch("/api/devtools/component-map")
      .then((r) => r.json())
      .then((map) => {
        componentMapRef.current = map;
      })
      .catch(() => {});
  }, [active]);

  useEffect(() => {
    if (!active) {
      document.documentElement.style.cursor = "";
      if (highlightRef.current) highlightRef.current.style.display = "none";
      if (labelRef.current) labelRef.current.style.display = "none";
      return;
    }

    document.documentElement.style.cursor = "crosshair";

    const isInspector = (el: Element | null): boolean => {
      let current = el;
      while (current) {
        if (
          current === hostRef.current ||
          current === highlightRef.current ||
          current === labelRef.current
        )
          return true;
        current = current.parentElement;
      }
      return false;
    };

    const onMouseMove = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || isInspector(target)) return;

      const rect = target.getBoundingClientRect();
      const hl = highlightRef.current!;
      const lb = labelRef.current!;
      hl.style.display = "block";
      hl.style.top = rect.top + "px";
      hl.style.left = rect.left + "px";
      hl.style.width = rect.width + "px";
      hl.style.height = rect.height + "px";

      const htmlTag =
        target.tagName.toLowerCase() +
        (target.id ? "#" + target.id : "") +
        (target.classList.length > 0
          ? "." + Array.from(target.classList).slice(0, 2).join(".")
          : "");

      const info = getQuickComponentInfo(target);
      const name = info?.name;
      const mapped = name ? componentMapRef.current[name] : undefined;
      const file =
        info?.file ||
        (mapped ? mapped.file.replace(/^.*[/\\]/, "") : undefined);
      const line = info?.line || mapped?.line;
      const fullFile = mapped?.file;

      if (name && (file || fullFile)) {
        lb.innerHTML =
          '<span style="color:#fff;font-weight:600">&lt;' +
          name +
          "&gt;</span>" +
          '<span style="display:block;opacity:0.7;font-size:10px;margin-top:1px">' +
          (fullFile || file) +
          (line ? ":" + line : "") +
          "</span>";
      } else if (name) {
        lb.innerHTML =
          '<span style="color:#fff;font-weight:600">&lt;' +
          name +
          "&gt;</span>" +
          '<span style="display:block;opacity:0.7;font-size:10px;margin-top:1px">' +
          htmlTag +
          "</span>";
      } else {
        lb.textContent = htmlTag;
      }

      lb.style.display = "block";
      lb.style.left = rect.left + "px";
      lb.style.top =
        Math.max(0, rect.top - (file || fullFile ? 38 : 26)) + "px";
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || isInspector(target)) return;
      e.preventDefault();
      e.stopPropagation();
      const desc = describeElement(target);
      if (desc) {
        const compName = desc.source?.componentName || desc.componentStack?.[0];
        if (compName && !desc.source?.fileName) {
          const mapped = componentMapRef.current[compName];
          if (mapped) {
            desc.source = {
              fileName: mapped.file,
              lineNumber: mapped.line,
              componentName: compName,
            };
          }
        }
        onPick(desc);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.documentElement.style.cursor = "";
      if (highlightRef.current) highlightRef.current.style.display = "none";
      if (labelRef.current) labelRef.current.style.display = "none";
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active, onPick, onCancel]);

  return null;
}

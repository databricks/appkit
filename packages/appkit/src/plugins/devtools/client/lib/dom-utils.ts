/// <reference lib="dom" />

export function summarizeText(value: string, maxLength: number): string {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 1) + "…";
}

export function escapeCssIdentifier(value: string): string {
  if (!value) return "";
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function createDomPath(element: Element): string {
  if (!(element instanceof Element)) return "";
  const segments: string[] = [];
  let current: Element | null = element;
  while (
    current &&
    current.nodeType === Node.ELEMENT_NODE &&
    segments.length < 6
  ) {
    let segment = current.tagName.toLowerCase();
    if (current.id) {
      segment += "#" + current.id;
      segments.unshift(segment);
      break;
    }
    const classNames = Array.from(current.classList || []).slice(0, 2);
    if (classNames.length > 0) {
      segment += "." + classNames.map(escapeCssIdentifier).join(".");
    } else if (current.parentElement) {
      const el = current;
      const siblings = Array.from(current.parentElement.children).filter(
        (child) => child.tagName === el.tagName,
      );
      if (siblings.length > 1) {
        segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      }
    }
    segments.unshift(segment);
    current = current.parentElement;
  }
  return segments.join(" > ");
}

export function createSelectorHint(element: Element): string {
  if (!(element instanceof Element)) return "";
  if (element.id) return "#" + escapeCssIdentifier(element.id);
  const dataTestId =
    element.getAttribute("data-testid") ||
    element.getAttribute("data-test") ||
    element.getAttribute("data-cy");
  if (dataTestId) {
    return '[data-testid="' + dataTestId.replace(/"/g, '\\"') + '"]';
  }
  const nameAttr = element.getAttribute("name");
  if (nameAttr) {
    return (
      element.tagName.toLowerCase() +
      '[name="' +
      nameAttr.replace(/"/g, '\\"') +
      '"]'
    );
  }
  const roleAttr = element.getAttribute("role");
  if (roleAttr) {
    return (
      element.tagName.toLowerCase() +
      '[role="' +
      roleAttr.replace(/"/g, '\\"') +
      '"]'
    );
  }
  return element.tagName.toLowerCase();
}

export interface SourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
  componentName?: string;
}

export interface ElementDescription {
  domPath: string;
  selector: string;
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  name?: string;
  type?: string;
  href?: string;
  text?: string;
  source?: SourceLocation;
  componentStack?: string[];
}

function getReactFiber(element: Element): any | null {
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

function getComponentName(fiber: any): string | undefined {
  if (!fiber || !fiber.type) return undefined;
  if (typeof fiber.type === "string") return undefined;
  return fiber.type.displayName || fiber.type.name || undefined;
}

function extractSourceFromFiber(
  fiber: any,
): { fileName: string; lineNumber: number; columnNumber?: number } | null {
  if (fiber._debugSource?.fileName && fiber._debugSource?.lineNumber) {
    return fiber._debugSource;
  }

  if (Array.isArray(fiber._debugInfo)) {
    for (const entry of fiber._debugInfo) {
      if (entry.fileName && entry.lineNumber) return entry;
      if (entry.stack) {
        const match = String(entry.stack).match(/\((.+?):(\d+):(\d+)\)/);
        if (match)
          return {
            fileName: match[1],
            lineNumber: Number(match[2]),
            columnNumber: Number(match[3]),
          };
      }
    }
  }

  if (fiber._debugOwner) {
    if (
      fiber._debugOwner._debugSource?.fileName &&
      fiber._debugOwner._debugSource?.lineNumber
    ) {
      return fiber._debugOwner._debugSource;
    }
    if (Array.isArray(fiber._debugOwner._debugInfo)) {
      for (const entry of fiber._debugOwner._debugInfo) {
        if (entry.fileName && entry.lineNumber) return entry;
      }
    }
  }

  return null;
}

function findSourceLocation(
  element: Element,
): { source: SourceLocation; componentStack: string[] } | null {
  let fiber = getReactFiber(element);
  if (!fiber) return null;

  const componentStack: string[] = [];
  let source: SourceLocation | null = null;

  while (fiber) {
    const name = getComponentName(fiber);
    if (name) {
      componentStack.push(name);
    }

    if (!source) {
      const ds = extractSourceFromFiber(fiber);
      if (ds) {
        source = {
          fileName: ds.fileName,
          lineNumber: ds.lineNumber,
          columnNumber: ds.columnNumber || undefined,
          componentName:
            name || getComponentName(fiber._debugOwner) || undefined,
        };
      }
    }

    if (source && componentStack.length >= 5) break;
    fiber = fiber.return;
  }

  if (!source && componentStack.length === 0) return null;
  return {
    source: source!,
    componentStack: componentStack.slice(0, 8),
  };
}

export function describeElement(
  element: Element | null,
): ElementDescription | undefined {
  if (!element || !(element instanceof Element)) return undefined;
  const textSource =
    "innerText" in element && (element as HTMLElement).innerText
      ? (element as HTMLElement).innerText
      : element.textContent || "";

  const reactInfo = findSourceLocation(element);

  return {
    domPath: createDomPath(element),
    selector: createSelectorHint(element),
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className:
      element.classList && element.classList.length > 0
        ? Array.from(element.classList).slice(0, 6).join(" ")
        : undefined,
    role: element.getAttribute("role") || undefined,
    name: element.getAttribute("name") || undefined,
    type:
      "type" in element ? element.getAttribute("type") || undefined : undefined,
    href:
      element instanceof HTMLAnchorElement ? toPath(element.href) : undefined,
    text: summarizeText(textSource, 160),
    source: reactInfo?.source || undefined,
    componentStack: reactInfo?.componentStack.length
      ? reactInfo.componentStack
      : undefined,
  };
}

export function toPath(input: string): string {
  try {
    const parsed = new URL(String(input), window.location.origin);
    return parsed.pathname + parsed.search;
  } catch {
    return String(input || "");
  }
}

export function isSameOrigin(input: string): boolean {
  try {
    const parsed = new URL(String(input), window.location.origin);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

/// <reference lib="dom" />

import { describeElement, isSameOrigin, summarizeText, toPath } from "./dom-utils";

const MAX_ITEMS = 50;

export interface NetworkEvent {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  path: string;
  status?: number;
  durationMs?: number;
}

export interface ActionEvent {
  type: string;
  label: string;
  timestamp: string;
  element?: ReturnType<typeof describeElement>;
}

export interface NetworkState {
  recentNetwork: NetworkEvent[];
  recentActions: ActionEvent[];
}

function generateId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "net-" + Math.random().toString(36).slice(2);
}

function trimArray<T>(items: T[]) {
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
}

export function interceptNetwork(sessionId: string, sessionHeader: string): NetworkState {
  const state: NetworkState = {
    recentNetwork: [],
    recentActions: [],
  };

  const withSessionHeader = (headersInit?: HeadersInit) => {
    const headers = new Headers(headersInit || {});
    headers.set(sessionHeader, sessionId);
    return headers;
  };

  const recordNetwork = (entry: Omit<NetworkEvent, "id" | "timestamp">) => {
    state.recentNetwork.unshift({
      id: generateId(),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    trimArray(state.recentNetwork);
  };

  // Patch fetch
  if (!(window as any).__APPKIT_INSPECTOR_FETCH_PATCHED__) {
    (window as any).__APPKIT_INSPECTOR_FETCH_PATCHED__ = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input?.url
              ? input.url
              : String(input || "");
      const requestMethod =
        init?.method ||
        (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
      const startedAt = performance.now();

      let finalInput = input;
      let finalInit = init;

      if (isSameOrigin(requestUrl)) {
        if (typeof Request !== "undefined" && input instanceof Request) {
          finalInput = new Request(input, { headers: withSessionHeader(input.headers) });
          finalInit = init;
        } else {
          finalInit = { ...(init || {}), headers: withSessionHeader(init?.headers) };
        }
      }

      try {
        const response = await originalFetch(finalInput, finalInit);
        recordNetwork({
          method: String(requestMethod || "GET").toUpperCase(),
          url: toPath(requestUrl),
          path: toPath(requestUrl),
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return response;
      } catch (error) {
        recordNetwork({
          method: String(requestMethod || "GET").toUpperCase(),
          url: toPath(requestUrl),
          path: toPath(requestUrl),
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw error;
      }
    };
  }

  // Patch XMLHttpRequest
  if (!(window as any).__APPKIT_INSPECTOR_XHR_PATCHED__) {
    (window as any).__APPKIT_INSPECTOR_XHR_PATCHED__ = true;
    const originalOpen = XMLHttpRequest.prototype.open as (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...args: unknown[]
    ) => void;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      (this as any).__appkitInspectorMeta = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
      };
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = (this as any).__appkitInspectorMeta;
      const startedAt = performance.now();
      if (meta && isSameOrigin(meta.url)) {
        try {
          this.setRequestHeader(sessionHeader, sessionId);
        } catch {}
      }
      this.addEventListener("loadend", () => {
        if (!meta) return;
        recordNetwork({
          method: meta.method,
          url: toPath(meta.url),
          path: toPath(meta.url),
          status: this.status || undefined,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
      return originalSend.call(this, body);
    };
  }

  // Record click actions
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const actionableTarget = target?.closest?.(
        "button, a, [role='button'], input, textarea, select, label",
      );
      if (!actionableTarget) return;
      const label =
        actionableTarget.getAttribute("aria-label") ||
        actionableTarget.textContent ||
        actionableTarget.getAttribute("href") ||
        "";
      if (!label) return;
      state.recentActions.unshift({
        type: "click",
        label: summarizeText(label, 120),
        timestamp: new Date().toISOString(),
        element: describeElement(actionableTarget),
      });
      trimArray(state.recentActions);
    },
    true,
  );

  return state;
}

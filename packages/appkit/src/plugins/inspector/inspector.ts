import { randomUUID } from "node:crypto";
import type express from "express";
import type {
  BasePlugin,
  IAppRouter,
  PluginManifest,
  PluginPhase,
} from "shared";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import manifest from "./manifest.json";
import type {
  IInspectorConfig,
  InspectorBridgeResponse,
  InspectorClientSnapshot,
  InspectorContextBundle,
  InspectorElementReference,
  InspectorInternalConfig,
  InspectorPluginMatch,
  InspectorPluginMetadata,
  InspectorPromptResponse,
  InspectorRecentEvent,
  InspectorRuntimeConfig,
} from "./types";

const logger = createLogger("inspector");

const INSPECT_QUERY_PARAM = "inspect";
const INSPECT_PERSIST_KEY = "appkit:inspector:enabled";
const INSPECT_SESSION_HEADER = "x-appkit-inspector-session";
const DEFAULT_BRIDGE_TARGET = "http://127.0.0.1:55107/context";
const DEFAULT_MAX_FORWARD_BYTES = 24_000;
const DEFAULT_MAX_RECENT_EVENTS = 20;
const DEFAULT_MAX_STORED_SESSIONS = 50;
const DEFAULT_MAX_STORED_EVENTS_PER_SESSION = 100;

type PluginConstructorWithManifest = {
  manifest?: {
    displayName?: string;
    description?: string;
  };
};

export class InspectorPlugin extends Plugin<IInspectorConfig> {
  static manifest = manifest as PluginManifest<"inspector">;
  static phase: PluginPhase = "deferred";

  protected declare config: IInspectorConfig;

  private sessionEvents = new Map<string, InspectorRecentEvent[]>();
  private requestEvents = new Map<string, InspectorRecentEvent>();
  private streamEvents = new Map<string, InspectorRecentEvent[]>();

  injectServerMiddleware(app: express.Application) {
    app.use((req, res, next) => {
      const sessionId = req.header(INSPECT_SESSION_HEADER);
      if (!sessionId) {
        next();
        return;
      }

      const startedAt = Date.now();
      const requestId = this.resolveRequestId(req);
      const streamId = this.resolveStreamId(req);
      const pluginName = this.resolvePluginName(req.path);

      res.once("finish", () => {
        this.recordEvent({
          sessionId,
          requestId,
          streamId,
          pluginName,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
          isError: res.statusCode >= 400,
        });
      });

      next();
    });
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "bootstrap",
      method: "get",
      path: "/bootstrap.js",
      handler: async (_req, res) => {
        res.type("application/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.send(this.getBootstrapScript());
      },
    });

    this.route(router, {
      name: "context",
      method: "post",
      path: "/context",
      handler: async (req, res) => {
        const bundle = this.resolveBundleFromBody(req.body);
        res.json(bundle);
      },
    });

    this.route(router, {
      name: "prompt",
      method: "post",
      path: "/prompt",
      handler: async (req, res) => {
        const bundle = this.resolveBundleFromBody(req.body);
        const response: InspectorPromptResponse = {
          prompt: this.buildPrompt(bundle),
          bundle,
        };
        res.json(response);
      },
    });

    this.route(router, {
      name: "events",
      method: "get",
      path: "/events",
      handler: async (req, res) => {
        const sessionId =
          typeof req.query.sessionId === "string" ? req.query.sessionId : "";
        const requestId =
          typeof req.query.requestId === "string" ? req.query.requestId : "";
        const streamId =
          typeof req.query.streamId === "string" ? req.query.streamId : "";

        if (requestId) {
          const event = this.requestEvents.get(requestId);
          res.json({ events: event ? [event] : [] });
          return;
        }

        if (streamId) {
          res.json({ events: this.streamEvents.get(streamId) ?? [] });
          return;
        }

        res.json({ events: this.getRecentEvents(sessionId) });
      },
    });

    this.route(router, {
      name: "bridge",
      method: "post",
      path: "/bridge",
      handler: async (req, res) => {
        try {
          const bundle = this.resolveBundleFromBody(req.body);
          const response = await this.forwardBundleToBridge(bundle);
          res.json(response);
        } catch (error) {
          logger.error("Failed to forward inspector context: %O", error);
          res.status(500).json({
            ok: false,
            error:
              error instanceof Error ? error.message : "Bridge forward failed",
          });
        }
      },
    });
  }

  getBootstrapContributions() {
    const src =
      this.getEndpoints().bootstrap ?? `/api/${this.name}/bootstrap.js`;

    return [
      {
        id: "inspector-bootstrap",
        html: `<script src="${src}" defer></script>`,
        position: "body-end" as const,
      },
    ];
  }

  getRuntimeConfigContribution() {
    return {
      inspector: this.getRuntimeInspectorConfig(),
    };
  }

  private getRuntimeInspectorConfig(): InspectorRuntimeConfig {
    return {
      enabledByDefault: this.config.enabledByDefault ?? false,
      bridgeTarget: this.config.bridgeTarget ?? DEFAULT_BRIDGE_TARGET,
      persistKey: INSPECT_PERSIST_KEY,
      activationParam: INSPECT_QUERY_PARAM,
      sessionHeader: INSPECT_SESSION_HEADER,
    };
  }

  private getInternalConfig(): InspectorInternalConfig {
    return this.config as InspectorInternalConfig;
  }

  private getRuntimePlugins(): Record<string, BasePlugin> {
    return this.getInternalConfig().plugins ?? {};
  }

  private resolveRequestId(req: express.Request): string {
    const headerId =
      req.header("x-request-id") ?? req.header("x-correlation-id");

    if (headerId) {
      return headerId.slice(0, 128);
    }

    const queryId =
      typeof req.query.requestId === "string" ? req.query.requestId : undefined;

    return queryId || randomUUID();
  }

  private resolveStreamId(req: express.Request): string | undefined {
    if (typeof req.query.streamId === "string" && req.query.streamId) {
      return req.query.streamId;
    }

    if (typeof req.query.requestId === "string" && req.query.requestId) {
      return req.query.requestId;
    }

    return undefined;
  }

  private resolvePluginName(pathname: string): string | undefined {
    if (pathname === "/health") return "server";

    const match = pathname.match(/^\/api\/([^/]+)/);
    return match?.[1];
  }

  private recordEvent(event: InspectorRecentEvent): void {
    const maxSessions =
      this.config.maxStoredSessions ?? DEFAULT_MAX_STORED_SESSIONS;
    const maxPerSession =
      this.config.maxStoredEventsPerSession ??
      DEFAULT_MAX_STORED_EVENTS_PER_SESSION;

    if (!this.sessionEvents.has(event.sessionId)) {
      this.sessionEvents.set(event.sessionId, []);
    }

    const sessionEvents = this.sessionEvents.get(event.sessionId) ?? [];
    sessionEvents.unshift(event);
    this.sessionEvents.set(
      event.sessionId,
      sessionEvents.slice(0, maxPerSession),
    );

    this.requestEvents.set(event.requestId, event);

    if (event.streamId) {
      const streamEvents = this.streamEvents.get(event.streamId) ?? [];
      streamEvents.unshift(event);
      this.streamEvents.set(
        event.streamId,
        streamEvents.slice(0, maxPerSession),
      );
    }

    while (this.sessionEvents.size > maxSessions) {
      const oldestSessionId = this.sessionEvents.keys().next().value;
      if (!oldestSessionId) break;
      this.sessionEvents.delete(oldestSessionId);
    }
  }

  private getRecentEvents(sessionId: string): InspectorRecentEvent[] {
    const maxRecent = this.config.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS;
    return (this.sessionEvents.get(sessionId) ?? []).slice(0, maxRecent);
  }

  private resolveBundleFromBody(body: unknown): InspectorContextBundle {
    if (
      body &&
      typeof body === "object" &&
      "bundle" in body &&
      (body as { bundle?: InspectorContextBundle }).bundle
    ) {
      return (body as { bundle: InspectorContextBundle }).bundle;
    }

    return this.buildContextBundle(body as InspectorClientSnapshot);
  }

  private buildContextBundle(
    snapshot: InspectorClientSnapshot,
  ): InspectorContextBundle {
    const runtimeConfig = this.getRuntimeInspectorConfig();
    const url = this.safeParseUrl(snapshot?.url);
    const availablePlugins = this.getAvailablePlugins();
    const plugin = this.matchPlugin(snapshot, availablePlugins);
    const recentEvents = this.filterRelatedEvents(
      this.getRecentEvents(snapshot?.sessionId ?? ""),
      plugin,
      url.pathname,
    );

    return {
      generatedAt: new Date().toISOString(),
      sessionId: snapshot?.sessionId ?? "unknown-session",
      app: {
        appName: (process.env.DATABRICKS_APP_NAME || "").trim() || "AppKit App",
        title: this.trimText(snapshot?.title || "", 160),
        url: this.redactUrl(snapshot?.url || ""),
        pathname: url.pathname,
        search: this.redactSearch(url.search),
      },
      page: {
        route: this.trimText(snapshot?.route || url.pathname, 200),
        selectedText: this.trimText(snapshot?.selectedText || "", 280),
        selectedElement: this.normalizeElementReference(
          snapshot?.selectedElement,
        ),
        textExcerpt: this.trimText(snapshot?.textExcerpt || "", 1600),
        recentActions: (snapshot?.actions ?? [])
          .map((action) => this.normalizeAction(action))
          .slice(0, this.config.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS),
      },
      plugin,
      client: {
        recentNetwork: (snapshot?.network ?? [])
          .map((event) => ({
            ...event,
            url: this.redactUrl(event.url),
            path: this.redactUrl(event.path),
          }))
          .slice(0, this.config.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS),
      },
      server: {
        recentEvents,
      },
      runtime: {
        availablePlugins,
      },
    };
  }

  private getAvailablePlugins(): InspectorPluginMetadata[] {
    return Object.values(this.getRuntimePlugins())
      .filter((plugin) => plugin.name !== "server" && plugin.name !== this.name)
      .map((plugin) => {
        const constructor = plugin.constructor as PluginConstructorWithManifest;
        const pluginManifest = constructor.manifest;

        return {
          name: plugin.name,
          displayName: pluginManifest?.displayName || plugin.name,
          description: pluginManifest?.description || "",
          endpoints: plugin.getEndpoints(),
        };
      });
  }

  private matchPlugin(
    snapshot: InspectorClientSnapshot,
    plugins: InspectorPluginMetadata[],
  ): InspectorPluginMatch | null {
    const pathname = this.safeParseUrl(snapshot?.url).pathname.toLowerCase();

    for (const plugin of plugins) {
      if (pathname.includes(plugin.name.toLowerCase())) {
        return { ...plugin, matchedBy: "pathname" };
      }
    }

    for (const networkEvent of snapshot?.network ?? []) {
      for (const plugin of plugins) {
        if (networkEvent.path.includes(`/api/${plugin.name}/`)) {
          return { ...plugin, matchedBy: "network" };
        }
      }
    }

    return null;
  }

  private filterRelatedEvents(
    events: InspectorRecentEvent[],
    plugin: InspectorPluginMatch | null,
    pathname: string,
  ): InspectorRecentEvent[] {
    const maxRecent = this.config.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS;

    if (!plugin) {
      return events.slice(0, maxRecent);
    }

    const related = events.filter((event) => {
      if (event.pluginName === plugin.name) return true;
      if (pathname && event.path.includes(pathname)) return true;
      return false;
    });

    return (related.length > 0 ? related : events).slice(0, maxRecent);
  }

  private buildPrompt(bundle: InspectorContextBundle): string {
    const pluginSection = bundle.plugin
      ? [
          `Likely AppKit plugin: ${bundle.plugin.displayName} (${bundle.plugin.name})`,
          `Why it matched: ${bundle.plugin.matchedBy}`,
          bundle.plugin.description
            ? `Plugin description: ${bundle.plugin.description}`
            : "",
          this.formatEndpointSection(bundle.plugin.endpoints),
        ]
          .filter(Boolean)
          .join("\n")
      : "Likely AppKit plugin: unknown";

    const clientNetwork = bundle.client.recentNetwork.length
      ? bundle.client.recentNetwork
          .map(
            (event) =>
              `- ${event.method} ${event.path}${event.status ? ` -> ${event.status}` : ""}`,
          )
          .join("\n")
      : "- none recorded";

    const serverEvents = bundle.server.recentEvents.length
      ? bundle.server.recentEvents
          .map(
            (event) =>
              `- ${event.method} ${event.path} -> ${event.statusCode} (${event.durationMs}ms)`,
          )
          .join("\n")
      : "- none recorded";

    const recentActions = bundle.page.recentActions.length
      ? bundle.page.recentActions
          .map((action) => {
            const elementRef = this.formatElementReference(action.element);
            return `- ${action.type}: ${action.label}${elementRef ? ` @ ${elementRef}` : ""}`;
          })
          .join("\n")
      : "- none recorded";

    return [
      "You are helping inspect a Databricks AppKit screen.",
      "",
      "Explain what this screen likely does, which AppKit plugin powers it, the relevant API routes, and the most likely debugging or implementation next steps.",
      "",
      `App: ${bundle.app.appName}`,
      `URL: ${bundle.app.url}`,
      `Route: ${bundle.page.route}`,
      bundle.app.title ? `Document title: ${bundle.app.title}` : "",
      "",
      pluginSection,
      "",
      "Recent client network activity:",
      clientNetwork,
      "",
      "Recent correlated server events:",
      serverEvents,
      "",
      "Recent user-triggered actions:",
      recentActions,
      "",
      bundle.page.selectedText
        ? `Selected text:\n${bundle.page.selectedText}`
        : "",
      bundle.page.selectedElement
        ? `Selected element: ${this.formatElementReference(bundle.page.selectedElement)}`
        : "",
      bundle.page.textExcerpt
        ? `Visible page excerpt:\n${bundle.page.textExcerpt}`
        : "",
      "",
      "Please return:",
      "1. A concise explanation of the screen.",
      "2. The likely data flow between UI and server.",
      "3. Any missing information or ambiguities.",
      "4. Concrete debugging or implementation suggestions.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private formatEndpointSection(endpoints: Record<string, string>): string {
    const entries = Object.entries(endpoints);
    if (entries.length === 0) {
      return "Relevant endpoints: none registered";
    }

    return [
      "Relevant endpoints:",
      ...entries.map(([name, value]) => `- ${name}: ${value}`),
    ].join("\n");
  }

  private async forwardBundleToBridge(
    bundle: InspectorContextBundle,
  ): Promise<InspectorBridgeResponse> {
    const target = this.config.bridgeTarget ?? DEFAULT_BRIDGE_TARGET;
    if (!this.isLocalBridgeTarget(target)) {
      throw new Error(
        `Inspector bridge target must resolve to localhost. Received ${target}`,
      );
    }

    const payload = this.sanitizeBundleForBridge(bundle);
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    return {
      ok: response.ok,
      status: response.status,
      target,
    };
  }

  private sanitizeBundleForBridge(bundle: InspectorContextBundle) {
    const payload: InspectorContextBundle = {
      ...bundle,
      app: {
        ...bundle.app,
        url: this.redactUrl(bundle.app.url),
        search: this.redactSearch(bundle.app.search),
      },
      page: {
        ...bundle.page,
        selectedText: this.trimText(bundle.page.selectedText || "", 280),
        selectedElement: this.normalizeElementReference(
          bundle.page.selectedElement,
        ),
        textExcerpt: this.trimText(bundle.page.textExcerpt || "", 1000),
        recentActions: bundle.page.recentActions.map((action) =>
          this.normalizeAction(action),
        ),
      },
      client: {
        recentNetwork: bundle.client.recentNetwork.map((event) => ({
          ...event,
          url: this.redactUrl(event.url),
          path: this.redactUrl(event.path),
        })),
      },
      server: {
        recentEvents: bundle.server.recentEvents.slice(
          0,
          this.config.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS,
        ),
      },
    };

    const maxBytes =
      this.config.maxForwardPayloadBytes ?? DEFAULT_MAX_FORWARD_BYTES;

    if (JSON.stringify(payload).length <= maxBytes) {
      return payload;
    }

    payload.page.textExcerpt =
      "[omitted: payload trimmed for bridge forwarding]";
    payload.client.recentNetwork = payload.client.recentNetwork.slice(0, 8);
    payload.server.recentEvents = payload.server.recentEvents.slice(0, 8);

    if (JSON.stringify(payload).length <= maxBytes) {
      return payload;
    }

    return {
      ...payload,
      runtime: {
        availablePlugins: payload.runtime.availablePlugins.map((plugin) => ({
          ...plugin,
          endpoints: {},
        })),
      },
    };
  }

  private isLocalBridgeTarget(target: string): boolean {
    try {
      const parsed = new URL(target);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        (parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "localhost" ||
          parsed.hostname === "::1")
      );
    } catch {
      return false;
    }
  }

  private redactUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl, "http://localhost");
      for (const key of [...parsed.searchParams.keys()]) {
        if (this.isSensitiveKey(key)) {
          parsed.searchParams.set(key, "[redacted]");
        }
      }
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return rawUrl;
    }
  }

  private redactSearch(rawSearch: string): string {
    try {
      const params = new URLSearchParams(rawSearch);
      for (const key of [...params.keys()]) {
        if (this.isSensitiveKey(key)) {
          params.set(key, "[redacted]");
        }
      }
      const serialized = params.toString();
      return serialized ? `?${serialized}` : "";
    } catch {
      return "";
    }
  }

  private isSensitiveKey(key: string): boolean {
    return /token|cookie|secret|authorization|auth|password|key/i.test(key);
  }

  private normalizeAction(
    action: InspectorContextBundle["page"]["recentActions"][number],
  ) {
    return {
      ...action,
      label: this.trimText(action.label || "", 120),
      element: this.normalizeElementReference(action.element),
    };
  }

  private normalizeElementReference(
    element?: InspectorElementReference,
  ): InspectorElementReference | undefined {
    if (!element) return undefined;

    const normalized: InspectorElementReference = {
      domPath: this.trimText(element.domPath || "", 220),
      tagName: this.trimText(element.tagName || "", 40).toLowerCase(),
    };

    if (!normalized.domPath || !normalized.tagName) {
      return undefined;
    }

    if (element.selector) {
      normalized.selector = this.trimText(element.selector, 180);
    }
    if (element.id) {
      normalized.id = this.trimText(element.id, 80);
    }
    if (element.className) {
      normalized.className = this.trimText(element.className, 120);
    }
    if (element.role) {
      normalized.role = this.trimText(element.role, 60);
    }
    if (element.name) {
      normalized.name = this.trimText(element.name, 80);
    }
    if (element.type) {
      normalized.type = this.trimText(element.type, 40);
    }
    if (element.href) {
      normalized.href = this.redactUrl(element.href);
    }
    if (element.text) {
      normalized.text = this.trimText(element.text, 180);
    }

    return normalized;
  }

  private formatElementReference(
    element?: InspectorElementReference,
  ): string | undefined {
    if (!element) return undefined;

    const parts = [
      element.selector,
      element.domPath,
      element.role ? `role=${element.role}` : "",
      element.text ? `"${element.text}"` : "",
    ].filter(Boolean);

    return parts.join(" | ");
  }

  private trimText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  private safeParseUrl(rawUrl?: string): URL {
    try {
      return new URL(rawUrl || "/", "http://localhost");
    } catch {
      return new URL("/", "http://localhost");
    }
  }

  private getBootstrapScript(): string {
    const config = JSON.stringify(this.getRuntimeInspectorConfig());

    return `
(() => {
  const serverConfig = (window.__CONFIG__ && window.__CONFIG__.inspector) || ${config};
  if (!serverConfig) return;

  const persistKey = serverConfig.persistKey || "${INSPECT_PERSIST_KEY}";
  const activationParam = serverConfig.activationParam || "${INSPECT_QUERY_PARAM}";
  const sessionHeader = serverConfig.sessionHeader || "${INSPECT_SESSION_HEADER}";
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get(activationParam);

  if (queryValue === "1") {
    localStorage.setItem(persistKey, "1");
  } else if (queryValue === "0") {
    localStorage.removeItem(persistKey);
  }

  const enabled =
    queryValue === "1" ||
    (queryValue !== "0" &&
      (localStorage.getItem(persistKey) === "1" || serverConfig.enabledByDefault));

  if (!enabled) return;

  const sessionStorageKey = persistKey + ":session-id";
  let sessionId = sessionStorage.getItem(sessionStorageKey);
  if (!sessionId) {
    sessionId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "session-" + Math.random().toString(36).slice(2);
    sessionStorage.setItem(sessionStorageKey, sessionId);
  }

  const MAX_ITEMS = 20;
  const recentNetwork = [];
  const recentActions = [];
  let latestBundle = null;
  let latestPrompt = "";
  let panelOpen = false;
  let cachedSelectedText = "";
  let cachedSelectedElement = undefined;

  const trimArray = (items) => {
    if (items.length > MAX_ITEMS) {
      items.length = MAX_ITEMS;
    }
  };

  const summarizeText = (value, maxLength) => {
    const normalized = String(value || "").replace(/\\s+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.length <= maxLength) return normalized;
    return normalized.slice(0, maxLength - 1) + "…";
  };

  const escapeCssIdentifier = (value) => {
    if (!value) return "";
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  };

  const createDomPath = (element) => {
    if (!(element instanceof Element)) return "";

    const segments = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 6) {
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
        const siblings = Array.from(current.parentElement.children).filter(
          (child) => child.tagName === current.tagName,
        );
        if (siblings.length > 1) {
          segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }

      segments.unshift(segment);
      current = current.parentElement;
    }

    return segments.join(" > ");
  };

  const createSelectorHint = (element) => {
    if (!(element instanceof Element)) return "";
    if (element.id) return "#" + escapeCssIdentifier(element.id);

    const dataTestId =
      element.getAttribute("data-testid") ||
      element.getAttribute("data-test") ||
      element.getAttribute("data-cy");
    if (dataTestId) {
      return '[data-testid="' + dataTestId.replace(/"/g, '\\"') + '"]';
    }

    if (element.getAttribute("name")) {
      return (
        element.tagName.toLowerCase() +
        '[name="' +
        element.getAttribute("name").replace(/"/g, '\\"') +
        '"]'
      );
    }

    if (element.getAttribute("role")) {
      return (
        element.tagName.toLowerCase() +
        '[role="' +
        element.getAttribute("role").replace(/"/g, '\\"') +
        '"]'
      );
    }

    return element.tagName.toLowerCase();
  };

  const describeElement = (element) => {
    if (!(element instanceof Element)) return undefined;

    const textSource =
      "innerText" in element && element.innerText
        ? element.innerText
        : element.textContent || "";

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
      type: "type" in element ? element.getAttribute("type") || undefined : undefined,
      href:
        element instanceof HTMLAnchorElement ? toPath(element.href) : undefined,
      text: summarizeText(textSource, 160),
    };
  };

  const toPath = (input) => {
    try {
      const parsed = new URL(String(input), window.location.origin);
      return parsed.pathname + parsed.search;
    } catch {
      return String(input || "");
    }
  };

  const isSameOrigin = (input) => {
    try {
      const parsed = new URL(String(input), window.location.origin);
      return parsed.origin === window.location.origin;
    } catch {
      return false;
    }
  };

  const recordNetwork = (entry) => {
    recentNetwork.unshift({
      id:
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : "net-" + Math.random().toString(36).slice(2),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    trimArray(recentNetwork);
    renderSummary();
  };

  const recordAction = (type, label, element) => {
    if (!label) return;
    recentActions.unshift({
      type,
      label: summarizeText(label, 120),
      timestamp: new Date().toISOString(),
      element: describeElement(element),
    });
    trimArray(recentActions);
    renderSummary();
  };

  const withSessionHeader = (headersInit) => {
    const headers = new Headers(headersInit || {});
    headers.set(sessionHeader, sessionId);
    return headers;
  };

  if (!window.__APPKIT_INSPECTOR_FETCH_PATCHED__) {
    window.__APPKIT_INSPECTOR_FETCH_PATCHED__ = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input && input.url
              ? input.url
              : String(input || "");
      const requestMethod =
        (init && init.method) ||
        (typeof Request !== "undefined" && input instanceof Request
          ? input.method
          : "GET");
      const startedAt = performance.now();

      let finalInput = input;
      let finalInit = init;

      if (isSameOrigin(requestUrl)) {
        if (typeof Request !== "undefined" && input instanceof Request) {
          finalInput = new Request(input, {
            headers: withSessionHeader(input.headers),
          });
          finalInit = init;
        } else {
          finalInit = {
            ...(init || {}),
            headers: withSessionHeader(init && init.headers),
          };
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

  if (!window.__APPKIT_INSPECTOR_XHR_PATCHED__) {
    window.__APPKIT_INSPECTOR_XHR_PATCHED__ = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__appkitInspectorMeta = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
      };
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
      const meta = this.__appkitInspectorMeta;
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

  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element ? event.target : null;
      const actionableTarget =
        target && target.closest
          ? target.closest("button, a, [role='button'], input, textarea, select, label")
          : null;
      if (!actionableTarget) return;
      const label =
        actionableTarget.getAttribute("aria-label") ||
        actionableTarget.textContent ||
        actionableTarget.getAttribute("href") ||
        "";
      recordAction("click", label, actionableTarget);
    },
    true,
  );

  const host = document.createElement("div");
  host.id = "appkit-inspector-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = \`
    :host {
      all: initial;
    }
    * { box-sizing: border-box; }
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: start center;
      padding: clamp(40px, 14vh, 160px) 16px 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      color: #e4e4e7;
      opacity: 0;
      pointer-events: none;
      transition: opacity 150ms ease;
    }
    .overlay.open {
      opacity: 1;
      pointer-events: auto;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(24px) saturate(1.2);
      -webkit-backdrop-filter: blur(24px) saturate(1.2);
    }
    .palette {
      position: relative;
      width: min(640px, calc(100vw - 32px));
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(24, 24, 27, 0.98);
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.4),
        0 24px 68px rgba(0, 0, 0, 0.55),
        0 8px 24px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      transform: translateY(8px) scale(0.98);
      opacity: 0;
      transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease;
    }
    .overlay.open .palette {
      transform: none;
      opacity: 1;
    }
    .palette::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
      pointer-events: none;
    }
    .header {
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-mark {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #818cf8;
      box-shadow: 0 0 12px rgba(129, 140, 248, 0.5);
    }
    .brand-label {
      font-size: 11px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.4);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .bridge-pill {
      display: inline-flex;
      align-items: center;
      max-width: 200px;
      padding: 2px 10px;
      height: 22px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.35);
      font-size: 11px;
      font-weight: 500;
      font-family: ui-monospace, "SF Mono", monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .search-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .search-icon {
      color: rgba(255, 255, 255, 0.3);
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }
    .search-icon svg {
      width: 18px;
      height: 18px;
    }
    .command-input {
      flex: 1;
      border: 0;
      outline: none;
      background: transparent;
      color: #fafafa;
      font-size: 17px;
      font-weight: 500;
      letter-spacing: -0.02em;
      padding: 6px 0;
      caret-color: #818cf8;
    }
    .command-input::placeholder {
      color: rgba(255, 255, 255, 0.25);
    }
    .shortcut-pills {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .body {
      padding: 8px;
    }
    .section-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.3);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 8px 8px 4px;
    }
    .command-list {
      display: grid;
      gap: 2px;
      max-height: min(40vh, 320px);
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
    }
    .command-list::-webkit-scrollbar { width: 4px; }
    .command-list::-webkit-scrollbar-track { background: transparent; }
    .command-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
    }
    .command-item {
      width: 100%;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: #e4e4e7;
      padding: 10px;
      cursor: pointer;
      text-align: left;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      transition: background 80ms ease;
    }
    .command-item:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .command-item.active {
      background: rgba(129, 140, 248, 0.1);
    }
    .command-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .command-icon {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      color: #a5b4fc;
    }
    .command-icon svg {
      width: 16px;
      height: 16px;
    }
    .command-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .command-title {
      font-size: 13px;
      font-weight: 500;
      color: #fafafa;
    }
    .command-subtitle {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.4);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .command-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .command-tag {
      padding: 2px 8px;
      height: 20px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.4);
      font-size: 11px;
      font-weight: 500;
    }
    .divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.06);
      margin: 4px 8px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      border-radius: 10px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.04);
      margin: 4px;
    }
    .summary div {
      padding: 8px 10px;
      background: rgba(24, 24, 27, 0.98);
      font-size: 12px;
      color: #e4e4e7;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .summary strong {
      display: block;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.3);
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .status {
      font-size: 12px;
      color: #818cf8;
      padding: 4px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 0;
      transition: opacity 150ms ease;
    }
    .status:empty {
      display: none;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #818cf8;
      flex-shrink: 0;
      animation: pulse-dot 1.2s ease-in-out infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    .prompt-shell {
      display: grid;
      gap: 6px;
      max-height: 0;
      opacity: 0;
      overflow: hidden;
      transition: max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease, padding 300ms ease;
      padding: 0 4px;
    }
    .prompt-shell.visible {
      max-height: 360px;
      opacity: 1;
      padding: 4px;
    }
    .prompt {
      width: 100%;
      min-height: 120px;
      max-height: 200px;
      resize: vertical;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(0, 0, 0, 0.3);
      color: #d4d4d8;
      padding: 12px;
      font: 12px/1.6 ui-monospace, "SF Mono", "Cascadia Code", monospace;
      box-sizing: border-box;
    }
    .prompt:focus {
      outline: none;
      border-color: rgba(129, 140, 248, 0.3);
    }
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .footer-hints {
      display: flex;
      gap: 12px;
    }
    .hint {
      display: flex;
      align-items: center;
      gap: 4px;
      color: rgba(255, 255, 255, 0.25);
      font-size: 11px;
    }
    kbd {
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.45);
      font: 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 500;
    }
    .meta-link {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.2);
    }
    .empty-state {
      padding: 20px;
      color: rgba(255, 255, 255, 0.3);
      font-size: 13px;
      text-align: center;
    }
    @media (max-width: 640px) {
      .summary { grid-template-columns: repeat(2, 1fr); }
      .command-meta { display: none; }
      .bridge-pill { display: none; }
    }
    @media (max-width: 480px) {
      .summary { grid-template-columns: 1fr; }
      .shortcut-pills { display: none; }
    }
  \`;

  shadow.appendChild(style);

  const shell = document.createElement("div");
  shell.className = "overlay";
  shell.innerHTML = \`
    <div class="backdrop" id="backdrop"></div>
    <div class="palette" role="dialog" aria-modal="true" aria-label="AppKit Inspector">
      <div class="header">
        <div class="topbar">
          <div class="brand">
            <span class="brand-mark"></span>
            <span class="brand-label">Inspector</span>
          </div>
          <span class="bridge-pill" id="bridge-target"></span>
        </div>
        <div class="search-row">
          <span class="search-icon"><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='8'/><line x1='21' y1='21' x2='16.65' y2='16.65'/></svg></span>
          <input id="command-input" class="command-input" type="text" autocomplete="off" spellcheck="false" placeholder="Type a command…" />
          <span class="shortcut-pills"><kbd>⌘</kbd><kbd>K</kbd></span>
        </div>
      </div>
      <div class="body">
        <div class="section-label">Actions</div>
        <div class="command-list" id="command-list"></div>
        <div class="divider"></div>
        <div class="summary" id="summary"></div>
        <div class="status" id="status"></div>
        <div class="prompt-shell" id="prompt-shell">
          <div class="section-label">Generated Prompt</div>
          <textarea class="prompt" id="prompt-output" placeholder="Prompt will appear here…"></textarea>
        </div>
      </div>
      <div class="footer">
        <div class="footer-hints">
          <span class="hint"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span class="hint"><kbd>↵</kbd> Run</span>
          <span class="hint"><kbd>esc</kbd> Close</span>
        </div>
        <span class="meta-link">?inspect=0 to disable</span>
      </div>
    </div>
  \`;

  shadow.appendChild(shell);

  const summaryEl = shadow.getElementById("summary");
  const statusEl = shadow.getElementById("status");
  const promptEl = shadow.getElementById("prompt-output");
  const bridgeTargetEl = shadow.getElementById("bridge-target");
  const commandInput = shadow.getElementById("command-input");
  const commandListEl = shadow.getElementById("command-list");
  const backdropEl = shadow.getElementById("backdrop");
  const promptShellEl = shadow.getElementById("prompt-shell");

  bridgeTargetEl.textContent = summarizeText(serverConfig.bridgeTarget || "", 36);
  console.info("[appkit-inspector] Enabled. Press Cmd/Ctrl+K to open the command palette.");

  const selectedText = () => {
    const selection = window.getSelection ? window.getSelection() : null;
    return selection ? summarizeText(selection.toString(), 280) : "";
  };

  const selectedElement = () => {
    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0) return undefined;

    const anchorNode = selection.anchorNode || selection.focusNode;
    if (!anchorNode) return undefined;

    const element =
      anchorNode.nodeType === Node.ELEMENT_NODE
        ? anchorNode
        : anchorNode.parentElement;

    return describeElement(element);
  };

  const pageText = () => {
    const text = document.body ? document.body.innerText : "";
    return summarizeText(text, 1600);
  };

  const currentSnapshot = () => ({
    sessionId,
    url: window.location.href,
    title: document.title || "",
    route: window.location.pathname + window.location.search,
    selectedText: panelOpen ? cachedSelectedText : selectedText(),
    selectedElement: panelOpen ? cachedSelectedElement : selectedElement(),
    textExcerpt: pageText(),
    network: recentNetwork.slice(0, MAX_ITEMS),
    actions: recentActions.slice(0, MAX_ITEMS),
  });

  const setStatus = (message) => {
    if (!message) { statusEl.innerHTML = ""; return; }
    const isLoading = message.includes("…");
    statusEl.innerHTML = (isLoading ? '<span class="status-dot"></span>' : "") + message;
  };

  let commandQuery = "";
  let selectedCommandIndex = 0;

  const openPalette = async () => {
    cachedSelectedText = selectedText();
    cachedSelectedElement = selectedElement();

    panelOpen = true;
    shell.classList.add("open");
    commandInput.value = commandQuery;
    renderCommands();
    requestAnimationFrame(() => {
      commandInput.focus();
      commandInput.select();
    });
    if (!latestBundle) {
      try {
        setStatus("Collecting screen context…");
        await loadBundle();
        setStatus("Context ready.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to load context.");
      }
    }
  };

  const closePalette = () => {
    panelOpen = false;
    shell.classList.remove("open");
    commandQuery = "";
    commandInput.value = "";
    selectedCommandIndex = 0;
    promptShellEl.classList.remove("visible");
    cachedSelectedText = "";
    cachedSelectedElement = undefined;
  };

  const commands = [
    {
      id: "explain",
      icon: "<svg viewBox='0 0 16 16' fill='currentColor'><path d='M8 1l2 5 5 2-5 2-2 5-2-5-5-2 5-2z'/></svg>",
      tag: "Prompt",
      title: "Explain this screen",
      subtitle: "Generate a prompt with browser context and correlated server events.",
      run: async () => {
        setStatus("Generating prompt…");
        await loadPrompt();
        setStatus("Prompt ready.");
      },
    },
    {
      id: "copy",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><rect x='4' y='4' width='8' height='10' rx='1.5'/><path d='M6 4V2.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V4'/></svg>",
      tag: "Clipboard",
      title: "Copy AI prompt",
      subtitle: "Copy the generated prompt to your clipboard.",
      run: async () => {
        setStatus("Preparing prompt to copy…");
        if (!latestPrompt) {
          await loadPrompt();
        }
        await navigator.clipboard.writeText(latestPrompt);
        setStatus("Prompt copied to clipboard.");
      },
    },
    {
      id: "bridge",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M3 13L13 3M13 3H6M13 3v7'/></svg>",
      tag: "Localhost",
      title: "Send to local bridge",
      subtitle: "Forward the redacted context bundle to your localhost bridge.",
      run: async () => {
        setStatus("Forwarding context to local bridge…");
        const bundle = await loadBundle();
        const response = await requestJson("/api/inspector/bridge", { bundle });
        setStatus(
          response && response.ok
            ? "Context sent to local bridge."
            : "Bridge responded but did not accept the payload.",
        );
      },
    },
    {
      id: "clear",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M2 2l12 12M14 2L2 14'/></svg>",
      tag: "Reset",
      title: "Clear context",
      subtitle: "Reset recorded network calls, actions, and cached prompts.",
      run: async () => {
        recentNetwork.length = 0;
        recentActions.length = 0;
        latestBundle = null;
        latestPrompt = "";
        cachedSelectedText = "";
        cachedSelectedElement = undefined;
        promptEl.value = "";
        promptShellEl.classList.remove("visible");
        renderSummary();
        setStatus("Context cleared — recording from now.");
      },
    },
  ];

  const filteredCommands = () => {
    if (!commandQuery.trim()) return commands;
    const query = commandQuery.trim().toLowerCase();
    return commands.filter(
      (command) =>
        command.title.toLowerCase().includes(query) ||
        command.subtitle.toLowerCase().includes(query),
    );
  };

  const renderCommands = () => {
    const items = filteredCommands();
    if (selectedCommandIndex >= items.length) {
      selectedCommandIndex = Math.max(0, items.length - 1);
    }

    if (items.length === 0) {
      commandListEl.innerHTML =
        '<div class="empty-state">No inspector commands match your search.</div>';
      return;
    }

    commandListEl.innerHTML = items
      .map(
        (command, index) => \`
          <button
            type="button"
            class="command-item\${index === selectedCommandIndex ? " active" : ""}"
            data-command-index="\${index}"
          >
            <span class="command-main">
              <span class="command-icon">\${command.icon}</span>
              <span class="command-copy">
                <span class="command-title">\${command.title}</span>
                <span class="command-subtitle">\${command.subtitle}</span>
              </span>
            </span>
            <span class="command-meta">
              <span class="command-tag">\${command.tag}</span>
              <kbd>Enter</kbd>
            </span>
          </button>
        \`,
      )
      .join("");
  };

  const runSelectedCommand = async () => {
    const items = filteredCommands();
    const command = items[selectedCommandIndex];
    if (!command) return;

    try {
      await command.run();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Command failed.");
    }
  };

  const renderSummary = () => {
    const pluginName =
      latestBundle && latestBundle.plugin
        ? latestBundle.plugin.displayName + " (" + latestBundle.plugin.name + ")"
        : "Unknown";

    const bundleText = latestBundle && latestBundle.page && latestBundle.page.selectedText;
    const resolvedText = bundleText || (panelOpen ? cachedSelectedText : selectedText());

    const bundleElement = latestBundle && latestBundle.page && latestBundle.page.selectedElement;
    const resolvedElement = bundleElement || (panelOpen ? cachedSelectedElement : undefined);

    const selectedElementLabel = resolvedElement
      ? summarizeText(
          resolvedElement.selector || resolvedElement.domPath || resolvedElement.tagName,
          70,
        )
      : "None";

    summaryEl.innerHTML = \`
      <div><strong>Route</strong>\${summarizeText(window.location.pathname + window.location.search, 90)}</div>
      <div><strong>Likely plugin</strong>\${summarizeText(pluginName, 90)}</div>
      <div><strong>Recent client calls</strong>\${recentNetwork.length}</div>
      <div><strong>Recent actions</strong>\${recentActions.length}</div>
      <div><strong>Selected text</strong>\${summarizeText(resolvedText, 90) || "None"}</div>
      <div><strong>Selected element</strong>\${selectedElementLabel}</div>
    \`;
  };

  const requestJson = async (path, payload) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [sessionHeader]: sessionId,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error("Request failed with status " + response.status);
    }
    return response.json();
  };

  const loadBundle = async () => {
    latestBundle = await requestJson("/api/inspector/context", currentSnapshot());
    renderSummary();
    return latestBundle;
  };

  const loadPrompt = async () => {
    const bundle = await loadBundle();
    const response = await requestJson("/api/inspector/prompt", { bundle });
    latestPrompt = response.prompt || "";
    promptEl.value = latestPrompt;
    promptShellEl.classList.add("visible");
    return response;
  };

  backdropEl.addEventListener("click", () => {
    closePalette();
  });

  commandInput.addEventListener("input", () => {
    commandQuery = commandInput.value;
    selectedCommandIndex = 0;
    renderCommands();
  });

  commandListEl.addEventListener("click", async (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest("[data-command-index]")
        : null;
    if (!target) return;

    const nextIndex = Number(target.getAttribute("data-command-index"));
    if (Number.isNaN(nextIndex)) return;
    selectedCommandIndex = nextIndex;
    renderCommands();
    await runSelectedCommand();
  });

  document.addEventListener("keydown", async (event) => {
    const key = String(event.key || "").toLowerCase();

    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      if (panelOpen) {
        closePalette();
      } else {
        await openPalette();
      }
      return;
    }

    if (!panelOpen) return;

    const items = filteredCommands();

    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }

    if (event.key === "ArrowDown" && items.length > 0) {
      event.preventDefault();
      selectedCommandIndex = (selectedCommandIndex + 1) % items.length;
      renderCommands();
      return;
    }

    if (event.key === "ArrowUp" && items.length > 0) {
      event.preventDefault();
      selectedCommandIndex =
        (selectedCommandIndex - 1 + items.length) % items.length;
      renderCommands();
      return;
    }

    if (event.key === "Enter" && items.length > 0) {
      event.preventDefault();
      await runSelectedCommand();
    }
  });

  window.addEventListener("popstate", () => {
    latestBundle = null;
    latestPrompt = "";
    renderSummary();
  });

  window.addEventListener("hashchange", () => {
    latestBundle = null;
    latestPrompt = "";
    renderSummary();
  });

  renderSummary();
})();
    `.trim();
  }
}

export const inspector = toPlugin(InspectorPlugin);

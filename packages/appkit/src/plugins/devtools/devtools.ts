import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import type {
  BasePlugin,
  IAppRouter,
  PluginManifest,
  PluginPhase,
} from "shared";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import {
  createAgentProviders,
  getAgentInfo,
  type DevtoolsAgentProvider,
} from "./agents";
import { buildComponentMap } from "./source-map";
import manifest from "./manifest.json";
import type {
  IDevtoolsConfig,
  DevtoolsBridgeResponse,
  DevtoolsClientSnapshot,
  DevtoolsConsoleEntry,
  DevtoolsContextBundle,
  DevtoolsElementReference,
  DevtoolsInternalConfig,
  DevtoolsPerformanceEntry,
  DevtoolsPluginHealthEntry,
  DevtoolsPluginMatch,
  DevtoolsPluginMetadata,
  DevtoolsPromptResponse,
  DevtoolsQueryEvent,
  DevtoolsRecentEvent,
  DevtoolsRuntimeConfig,
  DevtoolsStreamDebugEntry,
} from "./types";

const logger = createLogger("devtools");

const DEVTOOLS_QUERY_PARAM = "inspect";
const DEVTOOLS_PERSIST_KEY = "appkit:devtools:enabled";
const DEVTOOLS_SESSION_HEADER = "x-appkit-devtools-session";
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

export class DevtoolsPlugin extends Plugin<IDevtoolsConfig> {
  static manifest = manifest as PluginManifest<"devtools">;
  static phase: PluginPhase = "deferred";

  protected declare config: IDevtoolsConfig;

  private sessionEvents = new Map<string, DevtoolsRecentEvent[]>();
  private requestEvents = new Map<string, DevtoolsRecentEvent>();
  private streamEvents = new Map<string, DevtoolsRecentEvent[]>();

  private lastBundle: DevtoolsContextBundle | null = null;
  private lastPrompt = "";
  private lastReceivedAt = "";

  private agentProviders: DevtoolsAgentProvider[] = [];
  private activeAgentAbort: AbortController | null = null;
  private queryEvents: DevtoolsQueryEvent[] = [];
  private static readonly MAX_QUERY_EVENTS = 50;

  injectServerMiddleware(app: express.Application) {
    app.use((req, res, next) => {
      const sessionId = req.header(DEVTOOLS_SESSION_HEADER);
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
        this.storeLatest(bundle);
        res.json(bundle);
      },
    });

    this.route(router, {
      name: "prompt",
      method: "post",
      path: "/prompt",
      handler: async (req, res) => {
        const bundle = this.resolveBundleFromBody(req.body);
        const prompt = this.buildPrompt(bundle);
        this.storeLatest(bundle, prompt);
        const response: DevtoolsPromptResponse = { prompt, bundle };
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
        const bundle = this.resolveBundleFromBody(req.body);
        const prompt =
          typeof req.body?.prompt === "string" ? req.body.prompt : "";
        this.storeLatest(bundle, prompt);

        try {
          const response = await this.forwardBundleToBridge(bundle, prompt);
          res.json(response);
        } catch (error) {
          logger.debug(
            "Bridge forward skipped: %s",
            error instanceof Error ? error.message : "unknown error",
          );
          res.json({
            ok: true,
            bridgeForwarded: false,
            stored: true,
          });
        }
      },
    });

    this.route(router, {
      name: "last",
      method: "get",
      path: "/last",
      handler: async (_req, res) => {
        res.json({
          bundle: this.lastBundle,
          prompt: this.lastPrompt,
          receivedAt: this.lastReceivedAt,
        });
      },
    });

    this.route(router, {
      name: "last-summary",
      method: "get",
      path: "/last-summary",
      handler: async (_req, res) => {
        res.json({
          summary: this.summarizeBundle(this.lastBundle),
          hasPrompt: !!this.lastPrompt,
          receivedAt: this.lastReceivedAt,
        });
      },
    });

    this.route(router, {
      name: "last-prompt",
      method: "get",
      path: "/last-prompt",
      handler: async (_req, res) => {
        res.type("text/plain");
        res.send(
          this.lastPrompt ||
            "No prompt available. Pick an element in the devtools first.",
        );
      },
    });

    this.agentProviders = createAgentProviders();

    Plugin.onQueryEvent((event) => {
      this.recordQueryEvent(event);
    });

    this.route(router, {
      name: "component-map",
      method: "get",
      path: "/component-map",
      handler: async (_req, res) => {
        const cwd = process.cwd();
        const srcDir = this.config.sourceRoot || join(cwd, "client", "src");
        const map = buildComponentMap(srcDir);
        const result: Record<string, { file: string; line: number }> = {};
        for (const [name, loc] of map) {
          result[name] = { file: loc.file, line: loc.line };
        }
        res.json(result);
      },
    });

    this.route(router, {
      name: "agents",
      method: "get",
      path: "/agents",
      handler: async (_req, res) => {
        res.json({ agents: getAgentInfo(this.agentProviders) });
      },
    });

    this.route(router, {
      name: "agent-run",
      method: "post",
      path: "/agent/run",
      handler: async (req, res) => {
        const agentId =
          typeof req.body?.agentId === "string" ? req.body.agentId : "";
        const provider = this.agentProviders.find((p) => p.id === agentId);

        if (!provider) {
          res.status(404).json({ error: `Agent "${agentId}" not found` });
          return;
        }

        if (provider.mode === "stored") {
          this.storeLatest(
            this.resolveBundleFromBody(req.body),
            typeof req.body?.prompt === "string" ? req.body.prompt : "",
          );
          res.json({ ok: true, mode: "stored" });
          return;
        }

        if (provider.mode === "channel") {
          this.storeLatest(
            this.resolveBundleFromBody(req.body),
            typeof req.body?.prompt === "string" ? req.body.prompt : "",
          );
          res.json({ ok: true, mode: "channel" });
          return;
        }

        if (!provider.run || !provider.available) {
          res
            .status(400)
            .json({ error: `Agent "${agentId}" is not available` });
          return;
        }

        const prompt =
          typeof req.body?.prompt === "string" ? req.body.prompt : "";
        if (!prompt) {
          res.status(400).json({ error: "No prompt provided" });
          return;
        }

        if (this.activeAgentAbort) {
          this.activeAgentAbort.abort();
        }
        this.activeAgentAbort = new AbortController();
        const { signal } = this.activeAgentAbort;

        res.status(200);
        res.set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        let connectionClosed = false;
        const sendEvent = (data: unknown) => {
          if (connectionClosed) return;
          try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {}
        };

        res.on("close", () => {
          logger.info("Agent SSE connection closed by client");
          connectionClosed = true;
          this.activeAgentAbort?.abort();
        });

        try {
          const cwd = process.cwd();
          logger.info(
            "Running agent %s (mode=%s) cwd=%s",
            agentId,
            provider.mode,
            cwd,
          );
          logger.info("Prompt length: %d chars", prompt.length);

          for await (const message of provider.run(prompt, cwd, signal)) {
            logger.info(
              "Agent %s >> type=%s content=%s",
              agentId,
              message.type,
              (message.content || "").slice(0, 100),
            );
            if (signal.aborted || connectionClosed) break;
            sendEvent(message);
          }
          logger.info("Agent %s stream completed", agentId);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Agent failed";
          logger.error("Agent %s error: %s", agentId, msg);
          if (!signal.aborted && !connectionClosed) {
            sendEvent({ type: "error", content: msg });
          }
        } finally {
          sendEvent({ type: "done", content: "" });
          if (!connectionClosed) {
            try {
              res.end();
            } catch {}
          }
          if (this.activeAgentAbort?.signal === signal) {
            this.activeAgentAbort = null;
          }
        }
      },
    });

    this.route(router, {
      name: "agent-abort",
      method: "post",
      path: "/agent/abort",
      handler: async (_req, res) => {
        if (this.activeAgentAbort) {
          this.activeAgentAbort.abort();
          this.activeAgentAbort = null;
        }
        res.json({ ok: true });
      },
    });

    this.route(router, {
      name: "performance",
      method: "get",
      path: "/performance",
      handler: async (req, res) => {
        const sessionId =
          typeof req.query.sessionId === "string" ? req.query.sessionId : "";
        const thresholdMs =
          typeof req.query.threshold === "string"
            ? Number(req.query.threshold)
            : 500;
        res.json(this.getPerformanceSnapshot(sessionId, thresholdMs));
      },
    });

    this.route(router, {
      name: "health",
      method: "get",
      path: "/health-dashboard",
      handler: async (_req, res) => {
        res.json({ plugins: this.getPluginHealthDashboard() });
      },
    });

    this.route(router, {
      name: "streams",
      method: "get",
      path: "/streams",
      handler: async (_req, res) => {
        res.json(this.getStreamDebugSnapshot());
      },
    });

    this.route(router, {
      name: "stream-events",
      method: "get",
      path: "/stream-events",
      handler: async (req, res) => {
        const pluginName =
          typeof req.query.plugin === "string" ? req.query.plugin : "";
        const streamId =
          typeof req.query.streamId === "string" ? req.query.streamId : "";
        if (!pluginName || !streamId) {
          res.json({ events: [] });
          return;
        }

        const plugins = this.getRuntimePlugins();
        const plugin = Object.values(plugins).find(
          (p) => p.name === pluginName,
        );
        if (!plugin) {
          res.json({ events: [] });
          return;
        }

        try {
          const events = (plugin as any).getStreamEvents?.(streamId) ?? [];
          const safe = events.map((e: any) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(e.data);
            } catch {
              parsed = e.data;
            }
            return {
              id: e.id,
              type: e.type,
              data: parsed,
              timestamp: e.timestamp,
            };
          });
          res.json({ events: safe.reverse() });
        } catch {
          res.json({ events: [] });
        }
      },
    });

    this.route(router, {
      name: "queries",
      method: "get",
      path: "/queries",
      handler: async (_req, res) => {
        res.json({ queries: this.queryEvents });
      },
    });

    this.route(router, {
      name: "query-event",
      method: "post",
      path: "/query-event",
      handler: async (req, res) => {
        const event = req.body as DevtoolsQueryEvent;
        if (event?.queryKey) {
          this.recordQueryEvent(event);
        }
        res.json({ ok: true });
      },
    });
  }

  getBootstrapContributions() {
    const src =
      this.getEndpoints().bootstrap ?? `/api/${this.name}/bootstrap.js`;

    return [
      {
        id: "devtools-bootstrap",
        html: `<script src="${src}" defer></script>`,
        position: "body-end" as const,
      },
    ];
  }

  getRuntimeConfigContribution() {
    return {
      devtools: this.getDevtoolsRuntimeConfig(),
    };
  }

  private getDevtoolsRuntimeConfig(): DevtoolsRuntimeConfig {
    return {
      enabledByDefault: this.config.enabledByDefault ?? false,
      bridgeTarget: this.config.bridgeTarget ?? DEFAULT_BRIDGE_TARGET,
      persistKey: DEVTOOLS_PERSIST_KEY,
      activationParam: DEVTOOLS_QUERY_PARAM,
      sessionHeader: DEVTOOLS_SESSION_HEADER,
    };
  }

  private getInternalConfig(): DevtoolsInternalConfig {
    return this.config as DevtoolsInternalConfig;
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

  private recordEvent(event: DevtoolsRecentEvent): void {
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

  private getRecentEvents(sessionId: string): DevtoolsRecentEvent[] {
    const maxRecent = this.config.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS;
    return (this.sessionEvents.get(sessionId) ?? []).slice(0, maxRecent);
  }

  private resolveBundleFromBody(body: unknown): DevtoolsContextBundle {
    if (
      body &&
      typeof body === "object" &&
      "bundle" in body &&
      (body as { bundle?: DevtoolsContextBundle }).bundle
    ) {
      return (body as { bundle: DevtoolsContextBundle }).bundle;
    }

    return this.buildContextBundle(body as DevtoolsClientSnapshot);
  }

  private storeLatest(bundle: DevtoolsContextBundle, prompt?: string) {
    this.lastBundle = bundle;
    if (prompt !== undefined) this.lastPrompt = prompt;
    this.lastReceivedAt = new Date().toISOString();
  }

  private summarizeBundle(bundle: DevtoolsContextBundle | null) {
    if (!bundle) {
      return {
        appName: undefined,
        route: undefined,
        plugin: undefined,
        pickedElement: undefined,
        userPrompt: undefined,
        recentActions: 0,
        recentNetwork: 0,
        recentConsole: 0,
        recentServerEvents: 0,
      };
    }
    return {
      appName: bundle.app.appName,
      route: bundle.page.route,
      plugin: bundle.plugin?.name,
      pickedElement:
        bundle.page.pickedElement?.selector ||
        bundle.page.pickedElement?.tagName ||
        undefined,
      userPrompt: bundle.page.userPrompt || undefined,
      recentActions: bundle.page.recentActions.length,
      recentNetwork: bundle.client.recentNetwork.length,
      recentConsole: bundle.client.recentConsole.length,
      recentServerEvents: bundle.server.recentEvents.length,
    };
  }

  private buildContextBundle(
    snapshot: DevtoolsClientSnapshot,
  ): DevtoolsContextBundle {
    const runtimeConfig = this.getDevtoolsRuntimeConfig();
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
        pickedElement: this.normalizeElementReference(snapshot?.pickedElement),
        userPrompt: this.trimText(snapshot?.userPrompt || "", 500),
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
        recentConsole: (snapshot?.console ?? [])
          .map((entry) => this.sanitizeConsoleEntry(entry))
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

  private getAvailablePlugins(): DevtoolsPluginMetadata[] {
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
    snapshot: DevtoolsClientSnapshot,
    plugins: DevtoolsPluginMetadata[],
  ): DevtoolsPluginMatch | null {
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
    events: DevtoolsRecentEvent[],
    plugin: DevtoolsPluginMatch | null,
    pathname: string,
  ): DevtoolsRecentEvent[] {
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

  private buildPrompt(bundle: DevtoolsContextBundle): string {
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

    const hasUserPrompt =
      bundle.page.userPrompt && bundle.page.userPrompt.trim();
    const hasPickedElement = bundle.page.pickedElement;

    if (hasPickedElement) {
      return this.buildPickedElementPrompt(bundle, hasUserPrompt);
    }

    const consoleSection = this.formatConsoleSection(
      bundle.client.recentConsole,
    );

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
      consoleSection,
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

  private buildPickedElementPrompt(
    bundle: DevtoolsContextBundle,
    hasUserPrompt: string | false | undefined,
  ): string {
    const el = bundle.page.pickedElement!;
    const lines: string[] = [];

    lines.push("Element:");
    lines.push(`  Tag: <${el.tagName}>`);
    if (el.selector) lines.push(`  Selector: ${el.selector}`);
    if (el.domPath) lines.push(`  DOM path: ${el.domPath}`);
    if (el.text) lines.push(`  Text: "${el.text}"`);
    if (el.id) lines.push(`  ID: ${el.id}`);
    if (el.className) lines.push(`  Classes: ${el.className}`);
    if (el.role) lines.push(`  Role: ${el.role}`);

    if (el.source) {
      lines.push("");
      lines.push("Source:");
      const loc = el.source.columnNumber
        ? `${el.source.fileName}:${el.source.lineNumber}:${el.source.columnNumber}`
        : `${el.source.fileName}:${el.source.lineNumber}`;
      lines.push(`  File: ${loc}`);
      if (el.source.componentName) {
        lines.push(`  Component: <${el.source.componentName}>`);
      }
    }

    if (el.componentStack?.length) {
      lines.push(`  Component stack: ${el.componentStack.join(" > ")}`);
    }

    lines.push("");
    lines.push(`Route: ${bundle.page.route}`);

    if (hasUserPrompt) {
      lines.push("");
      lines.push(`Task: ${bundle.page.userPrompt}`);
    }

    return lines.join("\n");
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

  private formatConsoleSection(entries: DevtoolsConsoleEntry[]): string {
    const errors = entries.filter(
      (e) => e.level === "error" || e.level === "warn",
    );
    if (errors.length === 0 && entries.length === 0) {
      return "Recent console output:\n- none recorded";
    }

    const relevant = errors.length > 0 ? errors : entries;
    const lines = relevant.slice(0, 10).map((e) => {
      const prefix =
        e.level === "error"
          ? "ERROR"
          : e.level === "warn"
            ? "WARN"
            : e.level.toUpperCase();
      const msg =
        e.message.length > 200 ? `${e.message.slice(0, 200)}…` : e.message;
      return `- [${prefix}] ${msg}`;
    });

    return ["Recent console output:", ...lines].join("\n");
  }

  private async forwardBundleToBridge(
    bundle: DevtoolsContextBundle,
    prompt = "",
  ): Promise<DevtoolsBridgeResponse> {
    const target = this.config.bridgeTarget ?? DEFAULT_BRIDGE_TARGET;
    if (!this.isLocalBridgeTarget(target)) {
      throw new Error(
        `Devtools bridge target must resolve to localhost. Received ${target}`,
      );
    }

    const sanitizedBundle = this.sanitizeBundleForBridge(bundle);
    const payload = prompt
      ? { bundle: sanitizedBundle, prompt }
      : sanitizedBundle;

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

  private sanitizeBundleForBridge(bundle: DevtoolsContextBundle) {
    const payload: DevtoolsContextBundle = {
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
        pickedElement: this.normalizeElementReference(
          bundle.page.pickedElement,
        ),
        userPrompt: this.trimText(bundle.page.userPrompt || "", 500),
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
        recentConsole: (bundle.client.recentConsole ?? []).slice(
          0,
          this.config.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS,
        ),
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
    action: DevtoolsContextBundle["page"]["recentActions"][number],
  ) {
    return {
      ...action,
      label: this.trimText(action.label || "", 120),
      element: this.normalizeElementReference(action.element),
    };
  }

  private normalizeElementReference(
    element?: DevtoolsElementReference,
  ): DevtoolsElementReference | undefined {
    if (!element) return undefined;

    const normalized: DevtoolsElementReference = {
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
    if (element.source) {
      normalized.source = {
        fileName: this.trimText(element.source.fileName, 300),
        lineNumber: element.source.lineNumber,
        columnNumber: element.source.columnNumber,
        componentName: element.source.componentName
          ? this.trimText(element.source.componentName, 80)
          : undefined,
      };
    }
    if (element.componentStack?.length) {
      normalized.componentStack = element.componentStack.slice(0, 8);
    }

    return normalized;
  }

  private formatElementReference(
    element?: DevtoolsElementReference,
  ): string | undefined {
    if (!element) return undefined;

    const parts = [
      element.selector,
      element.domPath,
      element.role ? `role=${element.role}` : "",
      element.text ? `"${element.text}"` : "",
    ].filter(Boolean);

    if (element.source) {
      const loc = element.source;
      const fileRef = loc.columnNumber
        ? `${loc.fileName}:${loc.lineNumber}:${loc.columnNumber}`
        : `${loc.fileName}:${loc.lineNumber}`;
      parts.push(`source: ${fileRef}`);
      if (loc.componentName) {
        parts.push(`component: ${loc.componentName}`);
      }
    }

    if (element.componentStack?.length) {
      parts.push(`stack: ${element.componentStack.join(" > ")}`);
    }

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

  private devtoolsClientBundle: string | null = null;

  private getBootstrapScript(): string {
    if (this.devtoolsClientBundle) return this.devtoolsClientBundle;

    const config = JSON.stringify(this.getDevtoolsRuntimeConfig());
    const configScript = `window.__APPKIT_DEVTOOLS_SERVER_CONFIG__=${config};`;

    const distDir = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const clientPath = join(distDir, "dist/devtools-client.js");
    const clientBundle = readFileSync(clientPath, "utf-8");
    this.devtoolsClientBundle = configScript + "\n" + clientBundle;
    return this.devtoolsClientBundle;
  }

  private sanitizeConsoleEntry(
    entry: DevtoolsConsoleEntry,
  ): DevtoolsConsoleEntry {
    return {
      level: entry.level,
      message: this.trimText(entry.message || "", 500),
      timestamp: entry.timestamp,
      stack: entry.stack ? this.trimText(entry.stack, 500) : undefined,
    };
  }

  private getAllEvents(): DevtoolsRecentEvent[] {
    const all: DevtoolsRecentEvent[] = [];
    for (const events of this.sessionEvents.values()) {
      all.push(...events);
    }
    return all;
  }

  private getPerformanceSnapshot(sessionId: string, thresholdMs: number) {
    const events = sessionId
      ? this.getRecentEvents(sessionId)
      : this.getAllEvents();

    const slowRequests: DevtoolsPerformanceEntry[] = events
      .filter((e) => e.durationMs >= thresholdMs)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 20)
      .map((e) => ({
        method: e.method,
        path: e.path,
        statusCode: e.statusCode,
        durationMs: e.durationMs,
        timestamp: e.timestamp,
        pluginName: e.pluginName,
        isError: e.isError,
      }));

    const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);
    const errorCount = events.filter((e) => e.isError).length;

    return {
      totalRequests: events.length,
      errorCount,
      slowRequests,
      thresholdMs,
      timing:
        durations.length > 0
          ? {
              avg: Math.round(
                durations.reduce((a, b) => a + b, 0) / durations.length,
              ),
              p50: durations[Math.floor(durations.length * 0.5)] ?? 0,
              p95: durations[Math.floor(durations.length * 0.95)] ?? 0,
              max: durations[durations.length - 1] ?? 0,
            }
          : null,
    };
  }

  private getPluginHealthDashboard(): DevtoolsPluginHealthEntry[] {
    const allEvents = this.getAllEvents();
    const byPlugin = new Map<string, DevtoolsRecentEvent[]>();

    for (const event of allEvents) {
      const name = event.pluginName || "unknown";
      if (!byPlugin.has(name)) byPlugin.set(name, []);
      byPlugin.get(name)!.push(event);
    }

    const result: DevtoolsPluginHealthEntry[] = [];
    for (const [pluginName, events] of byPlugin) {
      const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);
      const errors = events.filter((e) => e.isError);
      const lastError = errors.length > 0 ? errors[0] : undefined;
      const totalRequests = events.length;
      const errorCount = errors.length;

      result.push({
        pluginName,
        totalRequests,
        errorCount,
        errorRate:
          totalRequests > 0
            ? Math.round((errorCount / totalRequests) * 10000) / 100
            : 0,
        avgDurationMs:
          durations.length > 0
            ? Math.round(
                durations.reduce((a, b) => a + b, 0) / durations.length,
              )
            : 0,
        p95DurationMs: durations[Math.floor(durations.length * 0.95)] ?? 0,
        maxDurationMs: durations[durations.length - 1] ?? 0,
        lastError,
      });
    }

    return result.sort((a, b) => b.totalRequests - a.totalRequests);
  }

  private getStreamDebugSnapshot() {
    const plugins = this.getRuntimePlugins();
    const streams: DevtoolsStreamDebugEntry[] = [];
    let totalActive = 0;

    for (const plugin of Object.values(plugins)) {
      if (plugin.name === this.name) continue;
      try {
        const debugInfo = (plugin as any).getStreamDebugInfo?.();
        if (!debugInfo?.streams) continue;

        for (const stream of debugInfo.streams) {
          if (!stream.isCompleted) totalActive++;
          const agoMs = Date.now() - stream.lastAccess;
          const agoSeconds = Math.floor(agoMs / 1000);
          const lastAccessAgo =
            agoSeconds < 60
              ? `${agoSeconds}s ago`
              : `${Math.floor(agoSeconds / 60)}m ago`;
          streams.push({
            pluginName: plugin.name,
            streamId: stream.streamId,
            clientCount: stream.clientCount,
            eventCount: stream.eventCount,
            isCompleted: stream.isCompleted,
            lastAccessAgo,
            lastAccessMs: stream.lastAccess,
          });
        }
      } catch {}
    }

    streams.sort((a, b) => b.lastAccessMs - a.lastAccessMs);
    return { totalActive, streams };
  }

  recordQueryEvent(event: DevtoolsQueryEvent): void {
    this.queryEvents.unshift(event);
    if (this.queryEvents.length > DevtoolsPlugin.MAX_QUERY_EVENTS) {
      this.queryEvents.length = DevtoolsPlugin.MAX_QUERY_EVENTS;
    }
  }
}

export const devtools = toPlugin(DevtoolsPlugin);

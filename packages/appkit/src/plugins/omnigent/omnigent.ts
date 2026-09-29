import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type express from "express";
import type { IAppRouter } from "shared";

import { runInUserContext, ServiceContext } from "../../context";
import {
  executeFromRegistry,
  toolsFromRegistry,
} from "../../core/agent/tools/define-tool";
import { createLogger } from "../../logging";
import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import { buildBundle } from "./bundle";
import {
  DEFAULT_HARNESSES,
  type GatewayModel,
  offerHarnesses,
  type HarnessOffer,
} from "./harnesses";
import { SessionKeys } from "./keys";
import manifest from "./manifest.json";
import {
  isWriteTool,
  type McpTool,
  McpToolServer,
  mcpToolName,
} from "./mcp-server";
import {
  MODE_POLICY_PREFIX,
  modeFromPolicies,
  modePolicies,
  OMNIGENT_MODES,
  type OmnigentMode,
} from "./policies";
import { profileFor } from "./runtime/env";
import { OmnigentRuntime } from "./runtime/runtime";
import { UserTokens } from "./tokens";
import type { CreateSessionRequest, IOmnigentConfig } from "./types";

const logger = createLogger("omnigent");

const ELICITATION_ACTIONS = new Set(["accept", "decline", "cancel"]);
const MODELS_TTL_MS = 5 * 60_000;

/**
 * Omnigent, embedded in the app.
 *
 * Runs an Omnigent server and one host per active user as supervised child
 * processes, so every harness Omnigent can route through Unity AI Gateway is
 * available to the app's users. Model calls are billed to the app's service
 * principal through a loopback gateway (no child holds a real credential);
 * the app's tools reach the harnesses over MCP and run as the session's user.
 */
export class OmnigentPlugin extends Plugin {
  static manifest = defineManifest<"omnigent">(manifest);

  protected static description =
    "Embedded Omnigent: Claude Agent SDK, Codex, Pi and more, through Unity AI Gateway";
  declare protected config: IOmnigentConfig;

  private runtime?: OmnigentRuntime;
  private readonly tokens = new UserTokens();
  private readonly keys = new SessionKeys(
    process.env.DATABRICKS_CLIENT_SECRET || process.env.OMNIGENT_KEY_SECRET,
  );
  private readonly mcp = new McpToolServer(() => this.mcpTools());
  private models?: { at: number; list: GatewayModel[] };

  async setup(): Promise<void> {
    const ctx = ServiceContext.get();
    const upstream = (await ctx.client.config.getHost())
      .toString()
      .replace(/\/+$/, "");
    const appDir = process.cwd();
    this.runtime = new OmnigentRuntime({
      root:
        this.config.runtime?.home ?? path.join(os.tmpdir(), "appkit-omnigent"),
      appDir,
      python:
        this.config.runtime?.python ??
        path.join(appDir, ".venv", "bin", "python"),
      upstream,
      token: () => this.serviceToken(),
      hostIdleMs: this.config.runtime?.hostIdleMs ?? 30 * 60_000,
    });
    // Do not block app start on the server.
    await this.runtime.start();
    this.runtime
      .whenReady()
      .catch((err) => logger.error("Omnigent did not start: %O", err));
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
    await this.runtime?.stop();
  }

  // ---------------------------------------------------------------- helpers

  private rt(): OmnigentRuntime {
    if (!this.runtime) throw new Error("Omnigent runtime is not started");
    return this.runtime;
  }

  private async serviceToken(): Promise<string> {
    const headers = new Headers();
    await ServiceContext.get().client.config.authenticate(headers);
    const auth = headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer "))
      throw new Error("service principal has no bearer token");
    return auth.slice("Bearer ".length);
  }

  /**
   * Chat models the app can call through Unity AI Gateway: the UC `system.ai`
   * model services, with the API types each one supports.
   */
  private async servedModels(): Promise<GatewayModel[]> {
    if (this.models && Date.now() - this.models.at < MODELS_TTL_MS)
      return this.models.list;
    const host = (await ServiceContext.get().client.config.getHost())
      .toString()
      .replace(/\/+$/, "");
    const headers = { Authorization: `Bearer ${await this.serviceToken()}` };

    const catalog: GatewayModel[] = [];
    try {
      let page: string | undefined;
      do {
        const q = new URLSearchParams({
          parent: "schemas/system.ai",
          max_results: "100",
        });
        if (page) q.set("page_token", page);
        const r = await fetch(
          `${host}/api/2.1/unity-catalog/model-services?${q}`,
          { headers },
        );
        if (!r.ok) break;
        const body = (await r.json()) as {
          model_services?: Array<{
            name: string;
            supported_api_types?: string[];
          }>;
          next_page_token?: string;
        };
        for (const svc of body.model_services ?? []) {
          const apiTypes = svc.supported_api_types ?? [];
          if (
            !apiTypes.some((t) =>
              /chat\/completions|responses|messages/.test(t),
            )
          )
            continue;
          catalog.push({
            name: svc.name.replace(/^model-services\//, ""),
            apiTypes,
          });
        }
        page = body.next_page_token || undefined;
      } while (page);
    } catch (err) {
      logger.warn("could not list UC model services: %s", String(err));
    }

    const list = catalog.sort((a, b) => a.name.localeCompare(b.name));
    this.models = { at: Date.now(), list };
    return list;
  }

  private allowedHarnesses(): string[] {
    return this.config.harnesses ?? DEFAULT_HARNESSES;
  }

  private async offers(user: string): Promise<HarnessOffer[]> {
    const rt = this.rt();
    const host = await rt.ensureHost(user);
    const r = await rt.request("GET", "/v1/hosts", user);
    const { hosts = [] } = (await r.json()) as {
      hosts?: Array<{
        host_id: string;
        configured_harnesses?: Record<string, boolean | string>;
      }>;
    };
    const mine = hosts.find((h) => h.host_id === host.hostId);
    return offerHarnesses({
      allowed: this.allowedHarnesses(),
      configured: mine?.configured_harnesses ?? {},
      shellAllowed: rt.shellHarnessesAllowed,
      models: await this.servedModels(),
    });
  }

  /** The app's tools plus opted-in plugins' tools, under MCP-safe names. */
  private mcpTools(): McpTool[] {
    const tools: McpTool[] = [];
    const registry = this.config.tools ?? {};
    for (const def of toolsFromRegistry(registry)) {
      tools.push({
        name: mcpToolName(def.name),
        definition: def,
        run: (args, signal) =>
          executeFromRegistry(registry, def.name, args, signal),
      });
    }
    const wanted = this.config.pluginTools;
    if (wanted && this.context) {
      for (const { name, provider } of this.context.getToolProviders()) {
        if (
          name === this.name ||
          (Array.isArray(wanted) && !wanted.includes(name))
        )
          continue;
        for (const def of provider.getAgentTools()) {
          tools.push({
            name: mcpToolName(def.name, name),
            definition: def,
            run: (args, signal) =>
              provider.executeAgentTool(def.name, args, signal),
          });
        }
      }
    }
    return tools;
  }

  private writeToolNames(): string[] {
    return this.mcpTools()
      .filter((t) => isWriteTool(t.definition))
      .map((t) => t.name);
  }

  /** The port the app actually listens on (dev servers fall back to a free one). */
  private appPort(): number {
    const server = this.context?.getPlugins().get("server") as
      | { getServer?: () => { address(): unknown } | null }
      | undefined;
    try {
      const addr = server?.getServer?.()?.address();
      if (addr && typeof addr === "object" && "port" in addr)
        return Number((addr as { port: number }).port);
    } catch {
      // server not listening yet
    }
    return Number(process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000);
  }

  private instructions(email: string | undefined): string {
    const base =
      this.config.instructions ??
      "You are an assistant inside this Databricks app. Use the app's tools to answer from its data.";
    return email
      ? `${base}\n\nThe signed-in user is ${email}. Tool calls run with their permissions.`
      : base;
  }

  private bundle(
    user: string,
    email: string | undefined,
    harness: string,
    model: string,
  ): Buffer {
    const key = this.keys.mint(user);
    const port = this.appPort();
    return buildBundle({
      name: "appkit",
      description: "AppKit app agent",
      harness,
      model,
      profile: profileFor(harness),
      instructions: this.instructions(email),
      mcpServers: [
        {
          name: "app",
          description: "This app's tools, run as the signed-in user",
          url: `http://127.0.0.1:${port}/api/${this.name}/mcp`,
          headers: this.keys.headers(key),
          timeout: 600,
        },
      ],
    });
  }

  private async setMode(
    user: string,
    sid: string,
    mode: OmnigentMode,
  ): Promise<void> {
    const rt = this.rt();
    const have = (await (
      await rt.request("GET", `/v1/sessions/${sid}/policies`, user)
    ).json()) as {
      data?: Array<{ id: string; name?: string }>;
    };
    for (const p of have.data ?? []) {
      if (String(p.name ?? "").startsWith(MODE_POLICY_PREFIX)) {
        await rt.request(
          "DELETE",
          `/v1/sessions/${sid}/policies/${p.id}`,
          user,
        );
      }
    }
    for (const p of modePolicies(mode, this.writeToolNames())) {
      const r = await rt.request("POST", `/v1/sessions/${sid}/policies`, user, {
        json: p,
      });
      if (!r.ok)
        throw new Error(
          `Could not set ${mode} mode: ${r.status} ${await r.text()}`,
        );
    }
  }

  /**
   * Waits until the session's runner has finished initializing. A turn posted
   * while it initializes is delivered twice (initialization replays the history
   * and so does the post); the duplicate is rejected with HTTP 204 and the
   * session is marked failed. Initialization publishes the session's REPL
   * terminal as a resource just before it finishes, so wait for that.
   */
  private async runnerReady(
    user: string,
    sid: string,
    ms: number,
  ): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await this.rt().request(
        "GET",
        `/v1/sessions/${sid}?include_items=true`,
        user,
      );
      if (r.ok) {
        const snap = (await r.json()) as {
          runner_online?: boolean;
          items?: Array<{ type?: string }>;
        };
        if (
          snap.runner_online &&
          (snap.items ?? []).some((i) => i.type === "resource_event")
        ) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** 404s unless the session exists and belongs to the caller (Omnigent scopes by user). */
  private async owned(
    user: string,
    sid: string,
    res: express.Response,
  ): Promise<Record<string, unknown> | null> {
    const r = await this.rt().request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sid)}?include_items=true`,
      user,
    );
    if (!r.ok) {
      res
        .status(r.status === 403 ? 404 : r.status)
        .json({ error: "Session not found" });
      return null;
    }
    return (await r.json()) as Record<string, unknown>;
  }

  private static async relay(
    res: express.Response,
    r: Response,
  ): Promise<void> {
    res.status(r.status);
    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.send(Buffer.from(await r.arrayBuffer()));
  }

  private handler(
    fn: (
      req: express.Request,
      res: express.Response,
      user: string,
    ) => Promise<void>,
  ) {
    return async (req: express.Request, res: express.Response) => {
      let user: string;
      try {
        user = this.resolveUserId(req);
        this.tokens.remember(req, user);
      } catch {
        res.status(401).json({ error: "Sign in to the app to use its agent." });
        return;
      }
      try {
        await fn(req, res, user);
      } catch (err) {
        logger.error("omnigent route failed: %O", err);
        if (!res.headersSent) {
          res
            .status(503)
            .json({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
  }

  // ----------------------------------------------------------------- routes

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "status",
      method: "get",
      path: "/status",
      handler: this.handler(async (_req, res) => {
        res.json(this.rt().status());
      }),
    });

    this.route(router, {
      name: "harnesses",
      method: "get",
      path: "/harnesses",
      handler: this.handler(async (_req, res, user) => {
        const harnesses = await this.offers(user);
        res.json({
          harnesses,
          modes: OMNIGENT_MODES,
          defaultMode: this.config.defaultMode ?? "ask",
          defaultHarness:
            harnesses.find((h) => h.id === this.config.defaultHarness)?.id ??
            harnesses[0]?.id,
        });
      }),
    });

    this.route(router, {
      name: "listSessions",
      method: "get",
      path: "/sessions",
      handler: this.handler(async (_req, res, user) => {
        await OmnigentPlugin.relay(
          res,
          await this.rt().request("GET", "/v1/sessions?limit=100", user),
        );
      }),
    });

    this.route(router, {
      name: "createSession",
      method: "post",
      path: "/sessions",
      handler: this.handler(async (req, res, user) => {
        const body = (req.body ?? {}) as CreateSessionRequest;
        const offers = await this.offers(user);
        const harness =
          offers.find(
            (h) => h.id === (body.harness ?? this.config.defaultHarness),
          ) ?? offers[0];
        if (!harness) {
          res
            .status(409)
            .json({ error: "No harness is available on this app." });
          return;
        }
        if (body.harness && body.harness !== harness.id) {
          res
            .status(400)
            .json({ error: `Harness not available: ${body.harness}` });
          return;
        }
        const model =
          body.model ?? this.config.defaultModel ?? harness.defaultModel;
        if (!model || !harness.models.includes(model)) {
          res.status(400).json({
            error: `Model not available for ${harness.id}: ${model ?? "(none)"}`,
          });
          return;
        }
        const mode = body.mode ?? this.config.defaultMode ?? "ask";
        if (!OMNIGENT_MODES.includes(mode)) {
          res.status(400).json({ error: `Unknown mode: ${mode}` });
          return;
        }
        const rt = this.rt();
        const host = await rt.ensureHost(user);
        const form = new FormData();
        form.set(
          "metadata",
          JSON.stringify({
            title:
              body.title ??
              body.message?.split("\n")[0]?.slice(0, 80) ??
              "New session",
            labels: { app: this.name, mode },
            host_type: "external",
            host_id: host.hostId,
            workspace: rt.layout.userWork(host.userId),
          }),
        );
        form.set(
          "bundle",
          new Blob(
            [
              new Uint8Array(
                this.bundle(
                  user,
                  req.header("x-forwarded-email"),
                  harness.id,
                  model,
                ),
              ),
            ],
            {
              type: "application/gzip",
            },
          ),
          "bundle.tar.gz",
        );
        const created = await rt.request("POST", "/v1/sessions", user, {
          body: form,
        });
        if (!created.ok) {
          await OmnigentPlugin.relay(res, created);
          return;
        }
        const { session_id: sid } = (await created.json()) as {
          session_id: string;
        };
        await this.setMode(user, sid, mode);
        if (body.message) {
          // A turn delivered before the session's runner is up can be rejected (HTTP 204); wait briefly.
          await this.runnerReady(user, sid, 5_000);
          const sent = await rt.request(
            "POST",
            `/v1/sessions/${sid}/events`,
            user,
            {
              json: userMessage(body.message),
            },
          );
          if (!sent.ok) {
            await OmnigentPlugin.relay(res, sent);
            return;
          }
        }
        res
          .status(201)
          .json({ session_id: sid, harness: harness.id, model, mode });
      }),
    });

    this.route(router, {
      name: "getSession",
      method: "get",
      path: "/sessions/:id",
      handler: this.handler(async (req, res, user) => {
        const snap = await this.owned(user, req.params.id, res);
        if (!snap) return;
        const pol = (await (
          await this.rt().request(
            "GET",
            `/v1/sessions/${req.params.id}/policies`,
            user,
          )
        ).json()) as { data?: Array<{ name?: string }> };
        res.json({
          ...snap,
          mode: modeFromPolicies((pol.data ?? []).map((p) => String(p.name))),
        });
      }),
    });

    this.route(router, {
      name: "deleteSession",
      method: "delete",
      path: "/sessions/:id",
      handler: this.handler(async (req, res, user) => {
        await OmnigentPlugin.relay(
          res,
          await this.rt().request(
            "DELETE",
            `/v1/sessions/${encodeURIComponent(req.params.id)}`,
            user,
          ),
        );
      }),
    });

    this.route(router, {
      name: "sendMessage",
      method: "post",
      path: "/sessions/:id/messages",
      handler: this.handler(async (req, res, user) => {
        const text = (req.body as { text?: string })?.text;
        if (!text) {
          res.status(400).json({ error: "text is required" });
          return;
        }
        await this.rt().ensureHost(user); // a host idled out or a fresh container
        await OmnigentPlugin.relay(
          res,
          await this.rt().request(
            "POST",
            `/v1/sessions/${encodeURIComponent(req.params.id)}/events`,
            user,
            {
              json: userMessage(text),
            },
          ),
        );
      }),
    });

    this.route(router, {
      name: "interrupt",
      method: "post",
      path: "/sessions/:id/interrupt",
      handler: this.handler(async (req, res, user) => {
        await OmnigentPlugin.relay(
          res,
          await this.rt().request(
            "POST",
            `/v1/sessions/${encodeURIComponent(req.params.id)}/events`,
            user,
            {
              json: { type: "interrupt", data: {} },
            },
          ),
        );
      }),
    });

    this.route(router, {
      name: "resolveElicitation",
      method: "post",
      path: "/sessions/:id/elicitations/:eid",
      handler: this.handler(async (req, res, user) => {
        const action = (req.body as { action?: string })?.action ?? "";
        if (!ELICITATION_ACTIONS.has(action)) {
          res
            .status(400)
            .json({ error: "action must be accept, decline or cancel" });
          return;
        }
        await this.rt().ensureHost(user);
        await OmnigentPlugin.relay(
          res,
          await this.rt().request(
            "POST",
            `/v1/sessions/${encodeURIComponent(req.params.id)}/elicitations/${encodeURIComponent(req.params.eid)}/resolve`,
            user,
            { json: { action } },
          ),
        );
      }),
    });

    this.route(router, {
      name: "setMode",
      method: "put",
      path: "/sessions/:id/mode",
      handler: this.handler(async (req, res, user) => {
        const mode = (req.body as { mode?: OmnigentMode })?.mode;
        if (!mode || !OMNIGENT_MODES.includes(mode)) {
          res.status(400).json({ error: "mode must be auto, ask or read" });
          return;
        }
        if (!(await this.owned(user, req.params.id, res))) return;
        await this.setMode(user, req.params.id, mode);
        res.json({ mode });
      }),
    });

    this.route(router, {
      name: "stream",
      method: "get",
      path: "/sessions/:id/stream",
      handler: this.handler(async (req, res, user) => {
        const ac = new AbortController();
        req.on("close", () => ac.abort());
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        const last = req.header("last-event-id");
        if (last) headers["Last-Event-ID"] = last;
        const up = await this.rt().request(
          "GET",
          `/v1/sessions/${encodeURIComponent(req.params.id)}/stream`,
          user,
          {
            headers,
            signal: ac.signal,
          },
        );
        if (!up.ok || !up.body) {
          await OmnigentPlugin.relay(res, up);
          return;
        }
        res.status(200);
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders();
        Readable.fromWeb(up.body as import("node:stream/web").ReadableStream)
          .on("error", () => res.end())
          .pipe(res);
      }),
    });

    // Tool calls from the harnesses (loopback). The session key is the only guard:
    // Apps proxy traffic also arrives from 127.0.0.1.
    this.route(router, {
      name: "mcp",
      method: "post",
      path: "/mcp",
      handler: async (req: express.Request, res: express.Response) => {
        const user = this.keys.verify(req.headers);
        if (!user) {
          res.status(401).json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Invalid session key" },
          });
          return;
        }
        const ac = new AbortController();
        res.on("close", () => ac.abort());
        let reply: unknown;
        try {
          const userContext = this.tokens.userContext(user);
          const run = () => this.mcp.handle(req.body, ac.signal);
          reply = userContext
            ? await runInUserContext(userContext, run)
            : await run();
        } catch (err) {
          reply = {
            jsonrpc: "2.0",
            id: (req.body as { id?: unknown })?.id ?? null,
            error: {
              code: -32002,
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        if (reply === null) {
          res.status(202).end();
          return;
        }
        res.json(reply);
      },
    });
  }

  exports() {
    return {
      /** Runtime health: server, sandbox, hosts, gateway counters. */
      status: () => this.rt().status(),
    };
  }
}

function userMessage(text: string) {
  return {
    type: "message",
    data: { role: "user", content: [{ type: "input_text", text }] },
  };
}

/**
 * @internal
 */
export const omnigent = toPlugin(OmnigentPlugin);

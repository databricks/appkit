import { Readable } from "node:stream";

import type express from "express";
import type { IAppRouter } from "shared";

import { ServiceContext } from "../../context";
import { createLogger } from "../../logging";
import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import { buildBundle } from "./bundle";
import { ManagedOmnigent, OmnigentScopeError } from "./client";
import {
  DEFAULT_HARNESSES,
  type GatewayModel,
  offerHarnesses,
  type HarnessOffer,
} from "./harnesses";
import manifest from "./manifest.json";
import type {
  CreateSessionRequest,
  IOmnigentConfig,
  OmnigentStatus,
} from "./types";

const logger = createLogger("omnigent");

const MODELS_TTL_MS = 5 * 60_000;

/**
 * Omnigent sessions for the app's users, on the workspace's managed
 * Omnigent server.
 *
 * Every call carries the signed-in user's token, so each session belongs to
 * that user, runs on a Databricks Sandbox host, and calls models through
 * Unity Gateway. The plugin builds the agent (instructions, harness, model)
 * and relays the conversation; Omnigent owns the session and its history,
 * which also appear in `<workspace>/omnigent`.
 */
export class OmnigentPlugin extends Plugin {
  static manifest = defineManifest<"omnigent">(manifest);

  protected static description =
    "Omnigent sessions (Claude Agent SDK, Pi, OpenAI Agents SDK) on Databricks Sandboxes";
  declare protected config: IOmnigentConfig;

  private readonly omnigent = new ManagedOmnigent(() => this.workspaceHost());
  private models?: { at: number; list: GatewayModel[] };

  // ---------------------------------------------------------------- helpers

  private async workspaceHost(): Promise<string> {
    return (await ServiceContext.get().client.getHost()).replace(/\/+$/, "");
  }

  /** Sessions this app created carry its name as a label and agent name. */
  private appName(): string {
    return (process.env.DATABRICKS_APP_NAME || "appkit")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
  }

  /**
   * The signed-in user's token. In local development there is no forwarded
   * token, so the developer's own CLI identity is used.
   */
  private async userToken(req: express.Request): Promise<string | null> {
    const forwarded = req.header("x-forwarded-access-token")?.trim();
    if (forwarded) return forwarded;
    if (process.env.NODE_ENV !== "development") return null;
    const headers = new Headers();
    await ServiceContext.get().client.authenticate(headers);
    return headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
  }

  /**
   * Chat models the user can call through Unity Gateway: the UC `system.ai`
   * model services, with the API types each one supports.
   */
  private async servedModels(token: string): Promise<GatewayModel[]> {
    if (this.models && Date.now() - this.models.at < MODELS_TTL_MS)
      return this.models.list;
    const host = await this.workspaceHost();
    const list: GatewayModel[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({
        parent: "schemas/system.ai",
        max_results: "100",
      });
      if (page) q.set("page_token", page);
      const r = await fetch(
        `${host}/api/2.1/unity-catalog/model-services?${q}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) {
        logger.warn("could not list UC model services: %d", r.status);
        break;
      }
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
          !apiTypes.some((t) => /chat\/completions|responses|messages/.test(t))
        )
          continue;
        list.push({
          name: svc.name.replace(/^model-services\//, ""),
          apiTypes,
        });
      }
      page = body.next_page_token || undefined;
    } while (page);
    list.sort((a, b) => a.name.localeCompare(b.name));
    if (list.length) this.models = { at: Date.now(), list };
    return list;
  }

  private async offers(token: string): Promise<HarnessOffer[]> {
    return offerHarnesses({
      allowed: this.config.harnesses ?? DEFAULT_HARNESSES,
      models: await this.servedModels(token),
    });
  }

  private instructions(email: string | undefined): string {
    const base =
      this.config.instructions ??
      "You are an assistant inside this Databricks app.";
    return email ? `${base}\n\nThe signed-in user is ${email}.` : base;
  }

  private bundle(
    email: string | undefined,
    harness: string,
    model: string,
  ): Buffer {
    return buildBundle({
      name: this.appName(),
      description: "AppKit app agent",
      harness,
      model,
      instructions: this.instructions(email),
    });
  }

  /** The session, or a 404 unless it belongs to this app (Omnigent already scopes it to the user). */
  private async owned(
    token: string,
    sid: string,
    res: express.Response,
    items = false,
  ): Promise<Record<string, unknown> | null> {
    const r = await this.omnigent.request(
      token,
      "GET",
      `/v1/sessions/${encodeURIComponent(sid)}${items ? "?include_items=true" : ""}`,
    );
    const snap = r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    const labels = (snap?.labels ?? {}) as Record<string, string>;
    if (!snap || labels.app !== this.appName()) {
      res.status(404).json({ error: "Session not found" });
      return null;
    }
    return snap;
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
      token: string,
    ) => Promise<void>,
  ) {
    return async (req: express.Request, res: express.Response) => {
      let token: string | null;
      try {
        token = await this.userToken(req);
      } catch {
        token = null;
      }
      if (!token) {
        res.status(401).json({ error: "Sign in to the app to use its agent." });
        return;
      }
      try {
        await fn(req, res, token);
      } catch (err) {
        if (err instanceof OmnigentScopeError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error("omnigent route failed: %O", err);
        if (!res.headersSent) {
          res
            .status(502)
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
      handler: this.handler(async (_req, res, token) => {
        let status: OmnigentStatus;
        try {
          const r = await this.omnigent.request(token, "GET", "/v1/info");
          const info = r.ok
            ? ((await r.json()) as {
                server_version?: string;
                managed_sandboxes_enabled?: boolean;
              })
            : null;
          status = info
            ? {
                ready: Boolean(info.managed_sandboxes_enabled),
                version: info.server_version,
                sandboxes: Boolean(info.managed_sandboxes_enabled),
                ...(info.managed_sandboxes_enabled
                  ? {}
                  : {
                      error:
                        "Databricks Sandbox is not enabled in this workspace.",
                    }),
              }
            : {
                ready: false,
                error: `Omnigent is not available in this workspace (HTTP ${r.status}). Enable the Omnigent preview.`,
              };
        } catch (err) {
          status = {
            ready: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        res.json(status);
      }),
    });

    this.route(router, {
      name: "harnesses",
      method: "get",
      path: "/harnesses",
      handler: this.handler(async (_req, res, token) => {
        const harnesses = await this.offers(token);
        res.json({
          harnesses,
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
      handler: this.handler(async (_req, res, token) => {
        const q = new URLSearchParams({
          agent_name: this.appName(),
          limit: "100",
        });
        await OmnigentPlugin.relay(
          res,
          await this.omnigent.request(token, "GET", `/v1/sessions?${q}`),
        );
      }),
    });

    this.route(router, {
      name: "createSession",
      method: "post",
      path: "/sessions",
      handler: this.handler(async (req, res, token) => {
        const body = (req.body ?? {}) as CreateSessionRequest;
        const offers = await this.offers(token);
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
        const form = new FormData();
        form.set(
          "metadata",
          JSON.stringify({
            title:
              body.title ??
              body.message?.split("\n")[0]?.slice(0, 80) ??
              "New session",
            labels: { app: this.appName() },
            host_type: "managed",
          }),
        );
        form.set(
          "bundle",
          new Blob(
            [
              new Uint8Array(
                this.bundle(req.header("x-forwarded-email"), harness.id, model),
              ),
            ],
            { type: "application/gzip" },
          ),
          "bundle.tar.gz",
        );
        // Returns once the Sandbox host is up (about 30 s on a cold start).
        const created = await this.omnigent.request(
          token,
          "POST",
          "/v1/sessions",
          { body: form },
        );
        if (!created.ok) {
          await OmnigentPlugin.relay(res, created);
          return;
        }
        const { session_id: sid } = (await created.json()) as {
          session_id: string;
        };
        if (body.message) {
          const sent = await this.omnigent.request(
            token,
            "POST",
            `/v1/sessions/${sid}/events`,
            { json: userMessage(body.message) },
          );
          if (!sent.ok) {
            await OmnigentPlugin.relay(res, sent);
            return;
          }
        }
        res.status(201).json({ session_id: sid, harness: harness.id, model });
      }),
    });

    this.route(router, {
      name: "getSession",
      method: "get",
      path: "/sessions/:id",
      handler: this.handler(async (req, res, token) => {
        const snap = await this.owned(token, req.params.id, res, true);
        if (snap) res.json(snap);
      }),
    });

    this.route(router, {
      name: "deleteSession",
      method: "delete",
      path: "/sessions/:id",
      handler: this.handler(async (req, res, token) => {
        if (!(await this.owned(token, req.params.id, res))) return;
        await OmnigentPlugin.relay(
          res,
          await this.omnigent.request(
            token,
            "DELETE",
            `/v1/sessions/${encodeURIComponent(req.params.id)}`,
          ),
        );
      }),
    });

    this.route(router, {
      name: "sendMessage",
      method: "post",
      path: "/sessions/:id/messages",
      handler: this.handler(async (req, res, token) => {
        const text = (req.body as { text?: string })?.text;
        if (!text) {
          res.status(400).json({ error: "text is required" });
          return;
        }
        if (!(await this.owned(token, req.params.id, res))) return;
        await OmnigentPlugin.relay(
          res,
          await this.omnigent.request(
            token,
            "POST",
            `/v1/sessions/${encodeURIComponent(req.params.id)}/events`,
            { json: userMessage(text) },
          ),
        );
      }),
    });

    this.route(router, {
      name: "interrupt",
      method: "post",
      path: "/sessions/:id/interrupt",
      handler: this.handler(async (req, res, token) => {
        if (!(await this.owned(token, req.params.id, res))) return;
        await OmnigentPlugin.relay(
          res,
          await this.omnigent.request(
            token,
            "POST",
            `/v1/sessions/${encodeURIComponent(req.params.id)}/events`,
            { json: { type: "interrupt", data: {} } },
          ),
        );
      }),
    });

    this.route(router, {
      name: "stream",
      method: "get",
      path: "/sessions/:id/stream",
      handler: this.handler(async (req, res, token) => {
        if (!(await this.owned(token, req.params.id, res))) return;
        const ac = new AbortController();
        req.on("close", () => ac.abort());
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        const last = req.header("last-event-id");
        if (last) headers["Last-Event-ID"] = last;
        const up = await this.omnigent.request(
          token,
          "GET",
          `/v1/sessions/${encodeURIComponent(req.params.id)}/stream`,
          { headers, signal: ac.signal },
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

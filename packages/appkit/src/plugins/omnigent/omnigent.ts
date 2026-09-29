import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type express from "express";
import type { IAppRouter } from "shared";

import { ServiceContext } from "../../context";
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
import manifest from "./manifest.json";
import { GATEWAY_PROFILE } from "./runtime/env";
import { OmnigentRuntime } from "./runtime/runtime";
import type { CreateSessionRequest, IOmnigentConfig } from "./types";

const logger = createLogger("omnigent");

const MODELS_TTL_MS = 5 * 60_000;

/**
 * Omnigent, embedded in the app.
 *
 * Runs an Omnigent server and one host per active user as supervised child
 * processes, so every harness Omnigent can route through Unity AI Gateway is
 * available to the app's users. Model calls are billed to the app's service
 * principal through a loopback gateway (no child holds a real credential).
 */
export class OmnigentPlugin extends Plugin {
  static manifest = defineManifest<"omnigent">(manifest);

  protected static description =
    "Embedded Omnigent: Claude Agent SDK, Pi and OpenAI Agents SDK, through Unity AI Gateway";
  declare protected config: IOmnigentConfig;

  private runtime?: OmnigentRuntime;
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
      models: await this.servedModels(),
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
      name: "appkit",
      description: "AppKit app agent",
      harness,
      model,
      profile: GATEWAY_PROFILE,
      instructions: this.instructions(email),
    });
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
            labels: { app: this.name },
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
                this.bundle(req.header("x-forwarded-email"), harness.id, model),
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
        res.status(201).json({ session_id: sid, harness: harness.id, model });
      }),
    });

    this.route(router, {
      name: "getSession",
      method: "get",
      path: "/sessions/:id",
      handler: this.handler(async (req, res, user) => {
        const snap = await this.owned(user, req.params.id, res);
        if (!snap) return;
        res.json(snap);
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
  }

  exports() {
    return {
      /** Runtime health: server, hosts, gateway counters. */
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

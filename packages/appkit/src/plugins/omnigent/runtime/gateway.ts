import { randomBytes } from "node:crypto";
import type http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { createLogger } from "../../../logging";

const logger = createLogger("omnigent:gateway");

/**
 * Paths a harness may reach through the gateway: model calls and the read-only
 * model listings Omnigent's catalog uses. Everything else is refused, so a
 * process that finds the placeholder token can call models and nothing more.
 */
const DEFAULT_GATEWAY_ALLOW: readonly RegExp[] = [
  /^\/ai-gateway\//,
  /^\/serving-endpoints\//,
  /^\/api\/2\.0\/serving-endpoints(\/|\?|$)/,
  /^\/api\/2\.1\/unity-catalog\/model-services(\/|\?|$)/,
];

interface GatewayOptions {
  /** The real workspace, e.g. `https://my-ws.cloud.databricks.com`. */
  upstream: string;
  /** Returns a bearer token for the identity model calls are billed to. */
  token: () => Promise<string>;
  /** TLS material for the https listener (Omnigent's token helper only serves https hosts). */
  tls: { key: Buffer; cert: Buffer };
  /** Loopback port; 0 picks a free one. */
  port?: number;
  allow?: readonly RegExp[];
}

interface GatewayStats {
  forwarded: number;
  denied: number;
}

/**
 * A loopback stand-in for the workspace that Omnigent's children use as their
 * Databricks host. They hold only a placeholder token; the gateway forwards
 * allowed paths to the real workspace with the real token. No child ever sees
 * a credential that works anywhere else.
 */
export class ModelGateway {
  readonly placeholder = `appkit-omnigent-${randomBytes(18).toString("hex")}`;
  readonly stats: GatewayStats = { forwarded: 0, denied: 0 };
  private readonly allow: readonly RegExp[];
  private readonly upstream: URL;
  private server?: https.Server;
  private port = 0;

  constructor(private readonly opts: GatewayOptions) {
    this.allow = opts.allow ?? DEFAULT_GATEWAY_ALLOW;
    this.upstream = new URL(opts.upstream);
  }

  /** The gateway's URL (https: Omnigent's token helper only serves https hosts). */
  get httpsUrl(): string {
    return `https://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handle(req, res);
    };
    this.server = https.createServer(this.opts.tls, handler);
    this.port = await listen(this.server, this.opts.port ?? 0);
    logger.debug("model gateway on %s", this.httpsUrl);
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
    this.server = undefined;
  }

  /** Whether a request may be forwarded. Exposed for tests. */
  permits(path: string, authorization: string | undefined): boolean {
    if (authorization && authorization !== `Bearer ${this.placeholder}`)
      return false;
    return this.allow.some((re) => re.test(path));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = req.url ?? "/";
    // Host metadata: answer "none" so the SDK stays on plain token auth.
    if (path.startsWith("/.well-known/")) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (!this.permits(path, req.headers.authorization)) {
      this.stats.denied++;
      res.writeHead(403, { "content-type": "application/json" }).end(
        JSON.stringify({
          error_code: "PERMISSION_DENIED",
          message:
            "This path is not available through the app's model gateway.",
        }),
      );
      req.resume();
      return;
    }
    let token: string;
    try {
      token = await this.opts.token();
    } catch (err) {
      logger.error("model gateway could not get a token: %O", err);
      res.writeHead(502).end();
      req.resume();
      return;
    }
    const headers = {
      ...req.headers,
      host: this.upstream.host,
      authorization: `Bearer ${token}`,
    };
    const upstream = https.request(
      {
        hostname: this.upstream.hostname,
        port: this.upstream.port || 443,
        path,
        method: req.method,
        headers,
      },
      (up) => {
        this.stats.forwarded++;
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      logger.warn("model gateway upstream error: %s", err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}

function listen(server: https.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

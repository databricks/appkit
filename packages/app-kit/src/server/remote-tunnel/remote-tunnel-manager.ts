import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server as HTTPServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import type { TunnelConnection } from "shared";
import { WebSocketServer } from "ws";
import {
  generateTunnelIdFromEmail,
  getConfigScript,
  parseCookies,
} from "../utils";
import { REMOTE_TUNNEL_ASSET_PREFIXES } from "./gate";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_ASSET_FETCH_TIMEOUT = 60_000;

interface DevFileReader {
  registerTunnelGetter(
    getter: (req: express.Request) => TunnelConnection | null,
  ): void;
}

/**
 * Remote tunnel manager for the App Kit.
 *
 * This class is responsible for managing the remote tunnels for the development server.
 * It also handles the asset fetching and the HMR for the development server.
 *
 * @example
 * ```ts
 * const remoteTunnelManager = new RemoteTunnelManager(devFileReader);
 * remoteTunnelManager.setup(app);
 * ```
 */
export class RemoteTunnelManager {
  private tunnels = new Map<string, TunnelConnection>();
  private wss: WebSocketServer;
  private hmrWss: WebSocketServer;
  private server?: HTTPServer;
  private devFileReader: DevFileReader;

  constructor(devFileReader: DevFileReader) {
    this.devFileReader = devFileReader;
    this.wss = new WebSocketServer({ noServer: true, path: "/dev-tunnel" });
    this.hmrWss = new WebSocketServer({ noServer: true, path: "/dev-hmr" });

    this.registerTunnelGetter();
  }

  setServer(server: HTTPServer) {
    this.server = server;
  }

  /** Asset middleware for the development server. */
  assetMiddleware() {
    return async (req: express.Request, res: express.Response) => {
      const email = req.headers["x-forwarded-email"] as string;

      // Try cookie first, then generate from email
      let tunnelId: string | undefined;
      const cookieHeader = req.headers.cookie;

      if (cookieHeader) {
        // Fast path: extract dev-tunnel-id from cookie without full parse
        const match = cookieHeader.match(/dev-tunnel-id=([^;]+)/);
        if (match) {
          tunnelId = match[1];
        }
      }

      if (!tunnelId) {
        tunnelId = generateTunnelIdFromEmail(email);
      }

      if (!tunnelId) return res.status(404).send("Tunnel not ready");

      const tunnel = this.tunnels.get(tunnelId);

      if (!tunnel) return res.status(404).send("Tunnel not found");

      const { ws, approvedViewers, pendingFetches } = tunnel;

      if (!approvedViewers.has(email)) {
        return res.status(403).send("Not approved for this tunnel");
      }

      const path = req.originalUrl;
      const requestId = randomUUID();

      const request = { type: "fetch", path, method: req.method, requestId };

      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingFetches.delete(requestId);
          reject(new Error("Asset fetch timeout"));
        }, MAX_ASSET_FETCH_TIMEOUT);

        pendingFetches.set(requestId, { resolve, reject, timeout });

        ws.send(JSON.stringify(request));
      }).catch((err) => {
        console.error(`Failed to fetch ${path}:`, err.message);
        return { status: 504, body: Buffer.from(""), headers: {} };
      });

      const r = response as any;

      res
        .status(r.status)
        .set(r.headers)
        .send(r.body || Buffer.from(""));
    };
  }

  /** Dev mode middleware for the development server. */
  devModeMiddleware() {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const dev = req.query?.dev;

      if (dev === undefined) {
        return next();
      }

      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/query") ||
        req.path.match(/\.(js|css|png|jpg|jpeg|svg|ico|json|woff|woff2|ttf)$/)
      ) {
        return next();
      }

      const viewerEmail = req.headers["x-forwarded-email"] as string;
      const isOwnerMode = dev === "" || dev === "true";

      const tunnelId = isOwnerMode
        ? generateTunnelIdFromEmail(viewerEmail)
        : dev.toString();

      if (!tunnelId) {
        return res.status(400).send("Invalid tunnel ID");
      }

      if (!isOwnerMode) {
        const approvalResponse = this.handleViewerApproval(
          tunnelId,
          viewerEmail,
          req.query.retry === "true",
          res,
        );

        if (approvalResponse) {
          return approvalResponse;
        }
      }

      res.cookie("dev-tunnel-id", tunnelId, {
        httpOnly: false,
        sameSite: "lax",
      });

      const indexPath = path.join(__dirname, "index.html");
      let html = fs.readFileSync(indexPath, "utf-8");
      html = html.replace("<body>", `<body>${getConfigScript()}`);

      res.send(html);
    };
  }

  /** Setup the dev mode middleware. */
  setup(app: express.Application) {
    app.use(this.devModeMiddleware());
    app.use(REMOTE_TUNNEL_ASSET_PREFIXES, this.assetMiddleware());
  }

  static isRemoteServerEnabled() {
    return (
      process.env.NODE_ENV !== "production" &&
      process.env.DISABLE_REMOTE_SERVING !== "true" &&
      // DATABRICKS_CLIENT_SECRET is set in the .env file for deployed environments
      Boolean(process.env.DATABRICKS_CLIENT_SECRET)
    );
  }

  private loadHtmlTemplate(
    filename: string,
    replacements: Record<string, string>,
  ): string {
    const filePath = path.join(__dirname, filename);
    let content = fs.readFileSync(filePath, "utf-8");

    for (const [key, value] of Object.entries(replacements)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }

    return content;
  }

  private handleViewerApproval(
    tunnelId: string,
    viewerEmail: string,
    retry: boolean,
    res: express.Response,
  ): express.Response | null {
    const tunnel = this.tunnels.get(tunnelId);

    if (!tunnel) {
      return res.status(404).send("Tunnel not found");
    }

    if (viewerEmail === tunnel.owner) {
      return null;
    }

    if (retry) {
      tunnel.rejectedViewers.delete(viewerEmail);
    }

    if (tunnel.rejectedViewers.has(viewerEmail)) {
      const html = this.loadHtmlTemplate("denied.html", { tunnelId });
      return res.status(403).send(html);
    }

    if (tunnel.approvedViewers.has(viewerEmail)) {
      return null;
    }

    if (!tunnel.pendingRequests.has(viewerEmail)) {
      const requestId = randomUUID();
      tunnel.pendingRequests.add(viewerEmail);
      tunnel.ws.send(
        JSON.stringify({
          type: "connection:request",
          requestId,
          viewer: viewerEmail,
        }),
      );
    }

    const html = this.loadHtmlTemplate("wait.html", { tunnelId });
    return res.status(200).send(html);
  }

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const email = req.headers["x-forwarded-email"] as string;
      const tunnelId = generateTunnelIdFromEmail(email);

      if (!tunnelId) return ws.close();

      this.tunnels.set(tunnelId, {
        ws,
        owner: email,
        approvedViewers: new Set([email]),
        pendingRequests: new Set(),
        rejectedViewers: new Set(),
        pendingFetches: new Map(),
        pendingFileReads: new Map(),
        waitingForBinaryBody: null,
      });

      ws.on("message", (msg, isBinary) => {
        const tunnel = this.tunnels.get(tunnelId);
        if (!tunnel) return;

        if (isBinary) {
          if (!tunnel.waitingForBinaryBody) {
            console.warn(
              "Received binary message but no requestId is waiting for body",
            );
            return;
          }

          const requestId = tunnel.waitingForBinaryBody;
          const pending = tunnel.pendingFetches.get(requestId);

          if (!pending || !pending.metadata) {
            console.warn("Received binary message but pending fetch not found");
            tunnel.waitingForBinaryBody = null;
            return;
          }

          tunnel.waitingForBinaryBody = null;
          clearTimeout(pending.timeout);
          tunnel.pendingFetches.delete(requestId);

          pending.resolve({
            status: pending.metadata.status,
            headers: pending.metadata.headers,
            body: msg as Buffer,
          });
          return;
        }

        try {
          const data = JSON.parse(msg.toString());

          if (data.type === "connection:response") {
            if (tunnel && data.viewer) {
              tunnel.pendingRequests.delete(data.viewer);

              if (data.approved) {
                tunnel.approvedViewers.add(data.viewer);
                console.log(
                  `✅ Approved ${data.viewer} for tunnel ${tunnelId}`,
                );
              } else {
                tunnel.rejectedViewers.add(data.viewer);
                console.log(`❌ Denied ${data.viewer} for tunnel ${tunnelId}`);
              }
            }
          } else if (data.type === "fetch:response:meta") {
            const pending = tunnel.pendingFetches.get(data.requestId);
            if (pending) {
              pending.metadata = {
                status: data.status,
                headers: data.headers,
              };
              if (
                data.status === 304 ||
                data.status === 204 ||
                (data.status >= 300 && data.status < 400)
              ) {
                clearTimeout(pending.timeout);
                tunnel.pendingFetches.delete(data.requestId);
                pending.resolve({
                  status: data.status,
                  headers: data.headers,
                  body: Buffer.from(""),
                });
              } else {
                tunnel.waitingForBinaryBody = data.requestId;
              }
            }
          } else if (data.type === "file:read:response") {
            const pending = tunnel.pendingFileReads.get(data.requestId);
            if (pending) {
              clearTimeout(pending.timeout);
              tunnel.pendingFileReads.delete(data.requestId);

              if (data.error) {
                pending.reject(new Error(data.error));
              } else {
                pending.resolve(data.content);
              }
            }
          }
        } catch (e) {
          console.error("Failed to parse WebSocket message:", e);
        }
      });

      ws.send(JSON.stringify({ type: "tunnel:ready", tunnelId }));

      ws.on("close", () => {
        const tunnel = this.tunnels.get(tunnelId);

        if (tunnel) {
          for (const [_, pending] of tunnel.pendingFetches) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Tunnel closed"));
          }
          tunnel.pendingFetches.clear();
        }

        this.tunnels.delete(tunnelId);
      });
    });

    this.hmrWss.on("connection", (browserWs, req) => {
      const cookies = parseCookies(req);
      const email = req.headers["x-forwarded-email"] as string;
      const tunnelId =
        cookies["dev-tunnel-id"] || generateTunnelIdFromEmail(email);

      if (!tunnelId) return browserWs.close();

      const cliTunnel = this.tunnels.get(tunnelId);

      if (!cliTunnel) return browserWs.close();

      const { ws: cliWs, approvedViewers } = cliTunnel;

      if (!approvedViewers.has(email)) {
        return browserWs.close(1008, "Not approved");
      }
      // Browser → CLI
      browserWs.on("message", (msg) => {
        const hmrStart = Date.now();
        console.log("browser -> cli browserWS message", msg.toString());
        cliWs.send(
          JSON.stringify({
            type: "hmr:message",
            body: msg.toString(),
            timestamp: hmrStart,
          }),
        );
      });

      // // CLI → Browser
      const cliHandler = (msg: Buffer | string, isBinary: boolean) => {
        // Ignore binary messages (they're for fetch responses, not HMR)
        if (isBinary) return;

        try {
          const data = JSON.parse(msg.toString());

          if (data.type === "hmr:message") {
            browserWs.send(data.body);
          }
        } catch {
          console.error(
            "Failed to parse CLI message for HMR:",
            msg.toString().substring(0, 100),
          );
        }
      };
      cliWs.on("message", cliHandler);

      browserWs.on("close", () => {
        cliWs.off("message", cliHandler);
      });
    });

    // // Browser HMR connection
    this.server?.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "";

      if (url.startsWith("/dev-tunnel")) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      } else if (url.startsWith("/dev-hmr")) {
        this.hmrWss.handleUpgrade(req, socket, head, (browserWs) => {
          this.hmrWss.emit("connection", browserWs, req);
        });
      }
    });
  }

  registerTunnelGetter() {
    this.devFileReader.registerTunnelGetter(
      this.getTunnelForRequest.bind(this),
    );
  }

  getTunnelForRequest(req: express.Request) {
    const email = req.headers["x-forwarded-email"] as string;
    const cookieHeader = req.headers.cookie;

    let tunnelId: string | undefined;

    if (cookieHeader) {
      const match = cookieHeader.match(/dev-tunnel-id=([^;]+)/);
      if (match) {
        tunnelId = match[1];
      }
    }

    if (!tunnelId) {
      tunnelId = generateTunnelIdFromEmail(email);
    }

    return tunnelId ? this.tunnels.get(tunnelId) || null : null;
  }

  cleanup() {
    for (const [, tunnel] of this.tunnels) {
      for (const [_, pending] of tunnel.pendingFetches) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Server shutting down"));
      }
      tunnel.pendingFetches.clear();
      tunnel.ws.close();
    }
    this.tunnels.clear();

    if (this.wss) {
      this.wss.close();
    }
    if (this.hmrWss) {
      this.hmrWss.close();
    }
  }
}

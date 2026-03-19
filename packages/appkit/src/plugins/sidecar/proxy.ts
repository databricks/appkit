import http from "node:http";
import posixPath from "node:path/posix";
import type { IAppRequest, IAppResponse } from "shared";
import { SidecarError } from "../../errors/sidecar";
import { createLogger } from "../../logging/logger";
import type { ProxyConfig, SidecarStatus } from "./types";

const logger = createLogger("sidecar:proxy");

const DEFAULTS: Required<ProxyConfig> = {
  forwardHeaders: "all",
  injectHeaders: {},
  timeout: 30_000,
  basePath: "/",
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class SidecarProxy {
  private readonly config: Required<ProxyConfig>;
  private readonly port: number;

  constructor(port: number, config?: ProxyConfig) {
    this.port = port;
    this.config = { ...DEFAULTS, ...config };
  }

  middleware(
    getStatus: () => SidecarStatus,
  ): (req: IAppRequest, res: IAppResponse) => void {
    return (req: IAppRequest, res: IAppResponse) => {
      const status = getStatus();
      if (status !== "healthy") {
        res.status(503).json({
          error: "Sidecar process is not ready",
          status,
        });
        return;
      }

      this.proxyRequest(req, res);
    };
  }

  private proxyRequest(req: IAppRequest, res: IAppResponse): void {
    let targetPath: string;
    try {
      targetPath = this.buildTargetPath(req.path);
    } catch {
      res.status(400).json({ error: "Invalid request path" });
      return;
    }
    const headers = this.buildHeaders(req);
    const fullPath = targetPath + this.extractQueryString(req.url);

    logger.debug(
      "%s %s → localhost:%d%s",
      req.method,
      req.path,
      this.port,
      fullPath,
    );

    const proxyReq = http.request(
      {
        hostname: "localhost",
        port: this.port,
        method: req.method,
        path: fullPath,
        headers,
        timeout: this.config.timeout,
      },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 502;
        logger.debug("%s %s ← %d", req.method, req.path, statusCode);

        res.status(statusCode);

        // Forward response headers (skip hop-by-hop)
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (
            !HOP_BY_HOP_HEADERS.has(key.toLowerCase()) &&
            value !== undefined
          ) {
            res.setHeader(key, value);
          }
        }

        // Pipe response body
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      logger.error("Proxy request failed: %s", err.message);

      if (!res.headersSent) {
        if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
          res.status(502).json({ error: "Sidecar process is unavailable" });
        } else {
          res.status(502).json({ error: "Failed to proxy request to sidecar" });
        }
      }
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: "Sidecar request timed out" });
      }
    });

    // Pipe request body to the sidecar
    req.pipe(proxyReq);
  }

  private buildTargetPath(originalPath: string): string {
    if (originalPath.includes("\0")) {
      throw SidecarError.proxyFailed(new Error("Invalid proxy path"));
    }

    const basePath = this.config.basePath.replace(/\/+$/, "") || "/";
    const normalized = posixPath.normalize(originalPath);
    const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
    const full = posixPath.normalize(`${basePath}${prefixed}`);

    if (!full.startsWith(basePath)) {
      throw SidecarError.proxyFailed(new Error("Invalid proxy path"));
    }

    return full;
  }

  private extractQueryString(url: string | undefined): string {
    if (!url) return "";
    const queryIndex = url.indexOf("?");
    return queryIndex >= 0 ? url.substring(queryIndex) : "";
  }

  private buildHeaders(req: IAppRequest): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};

    if (this.config.forwardHeaders === "all") {
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          value !== undefined &&
          key.toLowerCase() !== "host" &&
          !HOP_BY_HOP_HEADERS.has(key.toLowerCase())
        ) {
          headers[key] = value as string | string[];
        }
      }
    } else {
      for (const key of this.config.forwardHeaders) {
        const value = req.headers[key.toLowerCase()];
        if (value !== undefined) {
          headers[key.toLowerCase()] = value as string | string[];
        }
      }
      // Always forward auth-related headers
      const forwardUser = req.headers["x-forwarded-user"];
      if (forwardUser) headers["x-forwarded-user"] = forwardUser as string;
      const forwardToken = req.headers["x-forwarded-access-token"];
      if (forwardToken)
        headers["x-forwarded-access-token"] = forwardToken as string;
    }

    // Inject additional headers
    for (const [key, value] of Object.entries(this.config.injectHeaders)) {
      headers[key] = value;
    }

    // Rewrite host
    headers.host = `localhost:${this.port}`;

    return headers;
  }
}

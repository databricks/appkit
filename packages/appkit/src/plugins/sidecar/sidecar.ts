import type { IAppRequest, IAppRouter } from "shared";
import { SidecarError } from "../../errors/sidecar";
import { createLogger } from "../../logging/logger";
import { Plugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { HealthChecker } from "./health-checker";
import manifest from "./manifest.json";
import { ProcessManager } from "./process-manager";
import { SidecarProxy } from "./proxy";
import { StdioBridge } from "./stdio-bridge";
import { stdioRequestSchema } from "./stdio-schema";
import type { ISidecarConfig, SidecarExport } from "./types";

const logger = createLogger("sidecar");

const DEFAULT_STARTUP_TIMEOUT = 30_000;

function extractAuthHeaders(req: IAppRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const user = req.headers["x-forwarded-user"];
  if (typeof user === "string") headers["x-forwarded-user"] = user;
  const token = req.headers["x-forwarded-access-token"];
  if (typeof token === "string") headers["x-forwarded-access-token"] = token;
  return headers;
}

export class SidecarPlugin extends Plugin<ISidecarConfig> {
  static manifest = manifest as PluginManifest<"sidecar">;
  protected declare config: ISidecarConfig;

  private processManager: ProcessManager;
  private healthChecker: HealthChecker | null = null;
  private proxy: SidecarProxy | null = null;
  private stdioBridge: StdioBridge | null = null;
  private restarting = false;

  private get mode(): "http" | "stdio" {
    return this.config.mode ?? "http";
  }

  constructor(config: ISidecarConfig) {
    super(config);
    this.config = config;
    this.processManager = new ProcessManager(config);
  }

  async setup(): Promise<void> {
    if (this.mode === "stdio") {
      await this.setupStdio();
    } else {
      await this.setupHttp();
    }
  }

  private async setupHttp(): Promise<void> {
    await this.processManager.spawn();

    const port = this.processManager.port;
    const timeout = this.config.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT;

    this.healthChecker = new HealthChecker(port, this.config.healthCheck);

    const ready = await this.healthChecker.waitForReady(timeout);
    if (!ready) {
      await this.processManager.stop();
      throw SidecarError.startupFailed(this.config.command, timeout);
    }

    this.processManager.setHealthy();

    this.healthChecker.start({
      onHealthy: () => this.processManager.setHealthy(),
      onUnhealthy: async () => {
        if (this.restarting) return;
        this.restarting = true;
        try {
          this.processManager.setUnhealthy();
          logger.warn("Sidecar unhealthy, triggering restart");
          await this.processManager.restart();
        } catch (err) {
          logger.error("Failed to restart sidecar: %s", (err as Error).message);
        } finally {
          this.restarting = false;
        }
      },
    });

    this.proxy = new SidecarProxy(port, this.config.proxy);

    logger.info("Sidecar '%s' ready on port %d", this.config.command, port);
  }

  private async setupStdio(): Promise<void> {
    await this.processManager.spawn();

    const timeout = this.config.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT;

    this.stdioBridge = new StdioBridge(this.config.stdio ?? {}, this.telemetry);

    const stdin = this.processManager.getStdin();
    const stdout = this.processManager.getStdout();
    if (!stdin || !stdout) {
      await this.processManager.stop();
      throw new SidecarError(
        "Failed to obtain stdio streams from child process",
        {
          isRetryable: false,
        },
      );
    }

    this.stdioBridge.attach(stdin, stdout);

    const ready = await this.stdioBridge.waitForReady(timeout);
    if (!ready) {
      this.stdioBridge.destroy();
      await this.processManager.stop();
      throw SidecarError.startupFailed(this.config.command, timeout);
    }

    this.processManager.setHealthy();

    this.stdioBridge.startHealthCheck({
      onHealthy: () => this.processManager.setHealthy(),
      onUnhealthy: async () => {
        if (this.restarting) return;
        this.restarting = true;
        try {
          this.processManager.setUnhealthy();
          logger.warn("Sidecar stdio unhealthy, triggering restart");

          this.stdioBridge!.detach();
          await this.processManager.restart();

          const newStdin = this.processManager.getStdin();
          const newStdout = this.processManager.getStdout();
          if (newStdin && newStdout) {
            this.stdioBridge!.attach(newStdin, newStdout);
            await this.stdioBridge!.waitForReady(timeout);
          }
        } catch (err) {
          logger.error("Failed to restart sidecar: %s", (err as Error).message);
        } finally {
          this.restarting = false;
        }
      },
    });

    logger.info("Sidecar '%s' ready (stdio mode)", this.config.command);
  }

  injectRoutes(router: IAppRouter): void {
    if (this.mode === "stdio") {
      this.injectStdioRoutes(router);
    } else {
      this.injectHttpRoutes(router);
    }
  }

  private injectHttpRoutes(router: IAppRouter): void {
    if (!this.proxy) return;

    const proxyMiddleware = this.proxy.middleware(
      () => this.processManager.status,
    );

    router.all("/*", proxyMiddleware);

    const fullPath = `/api/${this.name}/*`;
    this.addSkipBodyParsingPath(fullPath);

    this.registerEndpoint("proxy", fullPath);
  }

  private injectStdioRoutes(router: IAppRouter): void {
    if (!this.stdioBridge) return;

    const bridge = this.stdioBridge;
    const getStatus = () => this.processManager.status;

    router.all("/*", async (req: IAppRequest, res) => {
      const status = getStatus();
      if (status !== "healthy") {
        res.status(503).json({ error: "Sidecar process is not ready", status });
        return;
      }

      const parsed = stdioRequestSchema.safeParse({
        path: req.path,
        method: req.method,
        body: req.body,
      });

      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request payload",
          details: parsed.error.flatten(),
        });
        return;
      }

      const authHeaders = extractAuthHeaders(req);

      try {
        const result = await bridge.sendRequest({
          ...parsed.data,
          headers: authHeaders,
        });

        res.status(result.status ?? 200);
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) {
            res.setHeader(k, v);
          }
        }
        res.json(result.body);
      } catch (err) {
        if (err instanceof SidecarError) {
          res.status(err.statusCode).json({ error: err.message });
        } else {
          res.status(502).json({ error: "Sidecar request failed" });
        }
      }
    });

    const fullPath = `/api/${this.name}/*`;
    this.registerEndpoint("stdio", fullPath);
  }

  abortActiveOperations(): void {
    super.abortActiveOperations();
    if (this.mode === "stdio") {
      this.stdioBridge?.destroy();
    } else {
      this.healthChecker?.stop();
    }
    this.processManager.stop(10_000).catch((err) => {
      logger.error("Error stopping sidecar during shutdown: %s", err.message);
    });
  }

  exports(): SidecarExport {
    return {
      getStatus: () => this.processManager.status,
      restart: () => this.processManager.restart(),
      stop: () => this.processManager.stop(),
      getOutput: (lines) => this.processManager.getOutput(lines),
      getPort: () => this.processManager.port,
    };
  }
}

export const sidecar = (config: ISidecarConfig) => ({
  plugin: SidecarPlugin as typeof SidecarPlugin,
  config,
  name: (config.name ?? SidecarPlugin.manifest.name) as string,
});

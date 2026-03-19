import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import type { IAppRequest, IAppRouter } from "shared";
import { SidecarError } from "../../errors/sidecar";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { HealthChecker } from "./health-checker";
import manifest from "./manifest.json";
import { ProcessManager } from "./process-manager";
import { SidecarProxy } from "./proxy";
import { StdioBridge } from "./stdio-bridge";
import { stdioRequestSchema } from "./stdio-schema";
import type {
  ISidecarConfig,
  SidecarDefinition,
  SidecarExport,
  SingleSidecarExport,
} from "./types";

const execAsync = promisify(exec);

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

interface SidecarInstance {
  definition: SidecarDefinition;
  processManager: ProcessManager;
  healthChecker: HealthChecker | null;
  proxy: SidecarProxy | null;
  stdioBridge: StdioBridge | null;
  restarting: boolean;
}

function normalizeSidecars(config: ISidecarConfig): SidecarDefinition[] {
  if ("sidecars" in config && Array.isArray(config.sidecars)) {
    return config.sidecars;
  }
  const { name: _name, host: _host, telemetry: _telemetry, ...def } = config;
  return [def as SidecarDefinition];
}

class SidecarPlugin extends Plugin {
  static manifest = manifest as PluginManifest<"sidecar">;
  protected declare config: ISidecarConfig;

  private instances = new Map<string, SidecarInstance>();

  constructor(config: ISidecarConfig) {
    super(config);
    this.config = config;

    const definitions = normalizeSidecars(config);
    const ids = new Set<string>();
    for (const def of definitions) {
      if (ids.has(def.id)) {
        throw new SidecarError(`Duplicate sidecar id: "${def.id}"`, {
          isRetryable: false,
        });
      }
      ids.add(def.id);

      this.instances.set(def.id, {
        definition: def,
        processManager: new ProcessManager(def),
        healthChecker: null,
        proxy: null,
        stdioBridge: null,
        restarting: false,
      });
    }
  }

  async setup(): Promise<void> {
    await Promise.all(
      Array.from(this.instances.values()).map((inst) =>
        this.setupInstance(inst),
      ),
    );
  }

  private async setupInstance(inst: SidecarInstance): Promise<void> {
    const { definition: def } = inst;

    if (Array.isArray(def.setupCommands) && def.setupCommands.length > 0) {
      for (const cmd of def.setupCommands) {
        try {
          logger.info(`[${def.id}] Running setup command: ${cmd}`);
          const { stdout, stderr } = await execAsync(cmd, { cwd: def.cwd });
          logger.info(`[${def.id}] Setup command "${cmd}" stdout: ${stdout}`);
          logger.info(`[${def.id}] Setup command "${cmd}" stderr: ${stderr}`);
        } catch (err) {
          logger.error(
            `[${def.id}] Failed to run setup command "${cmd}": ${(err as Error).message}`,
          );
          throw SidecarError.startupFailed(cmd, 0);
        }
      }
    }

    const mode = def.mode ?? "http";
    if (mode === "stdio") {
      await this.setupStdio(inst);
    } else {
      await this.setupHttp(inst);
    }
  }

  private async setupHttp(inst: SidecarInstance): Promise<void> {
    const { definition: def, processManager } = inst;
    await processManager.spawn();

    const port = processManager.port;
    const timeout = def.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT;

    inst.healthChecker = new HealthChecker(port, def.healthCheck);

    const ready = await inst.healthChecker.waitForReady(timeout);
    if (!ready) {
      await processManager.stop();
      throw SidecarError.startupFailed(def.command, timeout);
    }

    processManager.setHealthy();

    inst.healthChecker.start({
      onHealthy: () => processManager.setHealthy(),
      onUnhealthy: async () => {
        if (inst.restarting) return;
        inst.restarting = true;
        try {
          processManager.setUnhealthy();
          logger.warn("[%s] Sidecar unhealthy, triggering restart", def.id);
          await processManager.restart();
        } catch (err) {
          logger.error(
            "[%s] Failed to restart sidecar: %s",
            def.id,
            (err as Error).message,
          );
        } finally {
          inst.restarting = false;
        }
      },
    });

    inst.proxy = new SidecarProxy(port, this.telemetry, def.proxy);

    logger.info("[%s] Sidecar ready on port %d", def.id, port);
  }

  private async setupStdio(inst: SidecarInstance): Promise<void> {
    const { definition: def, processManager } = inst;
    await processManager.spawn();

    const timeout = def.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT;

    inst.stdioBridge = new StdioBridge(def.stdio ?? {}, this.telemetry);

    const stdin = processManager.getStdin();
    const stdout = processManager.getStdout();
    if (!stdin || !stdout) {
      await processManager.stop();
      throw new SidecarError(
        `[${def.id}] Failed to obtain stdio streams from child process`,
        { isRetryable: false },
      );
    }

    inst.stdioBridge.attach(stdin, stdout);

    const ready = await inst.stdioBridge.waitForReady(timeout);
    logger.info("[%s] Sidecar stdio ready: %s", def.id, ready);
    if (!ready) {
      inst.stdioBridge.destroy();
      await processManager.stop();
      throw SidecarError.startupFailed(def.command, timeout);
    }

    processManager.setHealthy();

    inst.stdioBridge.startHealthCheck({
      onHealthy: () => processManager.setHealthy(),
      onUnhealthy: async () => {
        if (inst.restarting) return;
        inst.restarting = true;
        try {
          processManager.setUnhealthy();
          logger.warn(
            "[%s] Sidecar stdio unhealthy, triggering restart",
            def.id,
          );

          const bridge = inst.stdioBridge;
          if (bridge) {
            bridge.detach();
            await processManager.restart();

            const newStdin = processManager.getStdin();
            const newStdout = processManager.getStdout();
            if (newStdin && newStdout) {
              bridge.attach(newStdin, newStdout);
              await bridge.waitForReady(timeout);
            }
          }
        } catch (err) {
          logger.error(
            "[%s] Failed to restart sidecar: %s",
            def.id,
            (err as Error).message,
          );
        } finally {
          inst.restarting = false;
        }
      },
    });

    logger.info("[%s] Sidecar ready (stdio mode)", def.id);
  }

  injectRoutes(router: IAppRouter): void {
    for (const inst of this.instances.values()) {
      const mode = inst.definition.mode ?? "http";
      if (mode === "stdio") {
        this.injectStdioRoutes(router, inst);
      } else {
        this.injectHttpRoutes(router, inst);
      }
    }
  }

  private injectHttpRoutes(router: IAppRouter, inst: SidecarInstance): void {
    if (!inst.proxy) return;

    const { definition: def, processManager } = inst;
    const proxyMiddleware = inst.proxy.middleware(() => processManager.status);

    const subRouter = Router();
    subRouter.all("/*", proxyMiddleware);
    router.use(`/${def.id}`, subRouter);

    const fullPath = `/api/${this.name}/${def.id}/*`;
    logger.info("[%s] Injecting HTTP routes: %s", def.id, fullPath);
    this.addSkipBodyParsingPath(fullPath);
    this.registerEndpoint(`proxy:${def.id}`, fullPath);
  }

  private injectStdioRoutes(router: IAppRouter, inst: SidecarInstance): void {
    if (!inst.stdioBridge) return;

    const { definition: def, processManager } = inst;
    const bridge = inst.stdioBridge;
    const getStatus = () => processManager.status;

    const subRouter = Router();
    subRouter.all("/*", async (req: IAppRequest, res) => {
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
    router.use(`/${def.id}`, subRouter);

    const fullPath = `/api/${this.name}/${def.id}/*`;
    this.registerEndpoint(`stdio:${def.id}`, fullPath);
  }

  abortActiveOperations(): void {
    super.abortActiveOperations();
    for (const inst of this.instances.values()) {
      const mode = inst.definition.mode ?? "http";
      if (mode === "stdio") {
        inst.stdioBridge?.destroy();
      } else {
        inst.healthChecker?.stop();
      }
      inst.processManager.stop(10_000).catch((err) => {
        logger.error(
          "[%s] Error stopping sidecar during shutdown: %s",
          inst.definition.id,
          err.message,
        );
      });
    }
  }

  private buildSingleExport(inst: SidecarInstance): SingleSidecarExport {
    return {
      getStatus: () => inst.processManager.status,
      restart: () => inst.processManager.restart(),
      stop: () => inst.processManager.stop(),
      getOutput: (lines) => inst.processManager.getOutput(lines),
      getPort: () => inst.processManager.port,
    };
  }

  private requireInstance(id: string): SidecarInstance {
    const inst = this.instances.get(id);
    if (!inst) {
      throw new SidecarError(`Unknown sidecar id: "${id}"`, {
        isRetryable: false,
      });
    }
    return inst;
  }

  exports(): SidecarExport {
    return {
      get: (id) => {
        const inst = this.instances.get(id);
        return inst ? this.buildSingleExport(inst) : undefined;
      },
      getAll: () => {
        const map = new Map<string, SingleSidecarExport>();
        for (const [id, inst] of this.instances) {
          map.set(id, this.buildSingleExport(inst));
        }
        return map;
      },
      getStatus: (id) => this.requireInstance(id).processManager.status,
      restart: (id) => this.requireInstance(id).processManager.restart(),
      stop: (id) => this.requireInstance(id).processManager.stop(),
      getOutput: (id, lines) =>
        this.requireInstance(id).processManager.getOutput(lines),
      getPort: (id) => this.requireInstance(id).processManager.port,
    };
  }
}

/**
 * @internal
 */
export const sidecar = toPlugin(SidecarPlugin);

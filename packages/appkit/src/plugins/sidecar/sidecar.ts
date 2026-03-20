import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { IAppRouter } from "shared";
import { SidecarError } from "../../errors/sidecar";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { httpHandler } from "./lib/http";
import type { ModeHandler, SidecarInstance } from "./lib/shared";
import { DEFAULT_STARTUP_TIMEOUT } from "./lib/shared";
import { stdioHandler } from "./lib/stdio";
import manifest from "./manifest.json";
import { ProcessManager } from "./process-manager";
import type {
  ISidecarConfig,
  SidecarDefinition,
  SidecarExport,
  SingleSidecarExport,
} from "./types";

const execAsync = promisify(exec);

const logger = createLogger("sidecar");

function normalizeSidecars(config: ISidecarConfig): SidecarDefinition[] {
  if ("sidecars" in config && Array.isArray(config.sidecars)) {
    return config.sidecars;
  }
  const { name: _name, host: _host, telemetry: _telemetry, ...def } = config;
  return [def as SidecarDefinition];
}

function handlerForMode(mode: string | undefined): ModeHandler {
  return mode === "stdio" ? stdioHandler : httpHandler;
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

      const mode = def.mode ?? "http";
      const handler = handlerForMode(mode);

      this.instances.set(def.id, {
        definition: def,
        processManager: new ProcessManager(def),
        handler,
        state:
          mode === "stdio"
            ? { mode: "stdio", stdioBridge: null }
            : { mode: "http", healthChecker: null, proxy: null },
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

    const timeout = def.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT;
    await inst.handler.setup(inst, this.telemetry, timeout);
  }

  injectRoutes(router: IAppRouter): void {
    const helpers = {
      pluginName: this.name,
      addSkipBodyParsingPath: (path: string) =>
        this.addSkipBodyParsingPath(path),
      registerEndpoint: (name: string, path: string) =>
        this.registerEndpoint(name, path),
    };

    for (const inst of this.instances.values()) {
      inst.handler.injectRoutes(router, inst, helpers);
    }
  }

  abortActiveOperations(): void {
    super.abortActiveOperations();
    for (const inst of this.instances.values()) {
      inst.handler.teardown(inst);
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

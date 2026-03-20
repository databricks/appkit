import { Router } from "express";
import type { IAppRouter } from "shared";
import { SidecarError } from "../../../errors/sidecar";
import { createLogger } from "../../../logging/logger";
import { HealthChecker } from "../health-checker";
import { SidecarProxy } from "../proxy";
import type {
  ModeHandler,
  PluginRouteHelpers,
  SidecarInstance,
} from "./shared";

const logger = createLogger("sidecar:http");

function narrowHttp(inst: SidecarInstance) {
  if (inst.state.mode !== "http") {
    throw new Error("Expected HTTP mode state");
  }
  return inst.state;
}

export const httpHandler: ModeHandler = {
  async setup(inst, telemetry, timeout) {
    const { definition: def, processManager } = inst;
    const state = narrowHttp(inst);

    await processManager.spawn();

    const port = processManager.port;

    state.healthChecker = new HealthChecker(port, def.healthCheck);

    const ready = await state.healthChecker.waitForReady(timeout);
    if (!ready) {
      await processManager.stop();
      throw SidecarError.startupFailed(def.command, timeout);
    }

    processManager.setHealthy();

    httpHandler.startHealthChecks(inst, timeout, telemetry);

    state.proxy = new SidecarProxy(port, telemetry, def.proxy);

    logger.info("[%s] Sidecar ready on port %d", def.id, port);
  },

  startHealthChecks(inst, timeout, telemetry) {
    const { definition: def, processManager } = inst;
    const state = narrowHttp(inst);

    const callbacks = {
      onHealthy: () => processManager.setHealthy(),
      onUnhealthy: async () => {
        if (inst.restarting) return;
        inst.restarting = true;
        try {
          processManager.setUnhealthy();
          logger.warn("[%s] Sidecar unhealthy, triggering restart", def.id);

          // Stop health checks during restart to avoid overlapping restarts
          state.healthChecker?.stop();
          await processManager.restart();

          // Port may have changed after restart (auto-assign)
          const newPort = processManager.port;
          state.healthChecker = new HealthChecker(newPort, def.healthCheck);
          state.proxy = new SidecarProxy(newPort, telemetry, def.proxy);

          // Wait for the restarted process to become healthy before resuming checks
          const ready = await state.healthChecker?.waitForReady(timeout);
          if (ready) {
            processManager.setHealthy();
          }

          // Resume periodic health checking with the same callbacks
          state.healthChecker?.start(callbacks);
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
    };

    state.healthChecker?.start(callbacks);
  },

  injectRoutes(
    router: IAppRouter,
    inst: SidecarInstance,
    helpers: PluginRouteHelpers,
  ) {
    const state = narrowHttp(inst);
    if (!state.proxy) return;

    const { definition: def, processManager } = inst;

    const subRouter = Router();
    subRouter.all("/*", (req, res) => {
      if (!state.proxy) {
        res.status(503).json({ error: "Sidecar proxy not ready" });
        return;
      }
      state.proxy.middleware(() => processManager.status)(req, res);
    });
    router.use(`/${def.id}`, subRouter);

    const fullPath = `/api/${helpers.pluginName}/${def.id}/*`;
    logger.info("[%s] Injecting HTTP routes: %s", def.id, fullPath);
    helpers.addSkipBodyParsingPath(fullPath);
    helpers.registerEndpoint(`proxy:${def.id}`, fullPath);
  },

  teardown(inst) {
    const state = narrowHttp(inst);
    state.healthChecker?.stop();
  },
};

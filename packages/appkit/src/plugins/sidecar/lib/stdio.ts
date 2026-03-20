import { Router } from "express";
import type { IAppRequest, IAppRouter } from "shared";
import { SidecarError } from "../../../errors/sidecar";
import { createLogger } from "../../../logging/logger";
import { StdioBridge } from "../stdio-bridge";
import { stdioRequestSchema } from "../stdio-schema";
import type {
  ModeHandler,
  PluginRouteHelpers,
  SidecarInstance,
} from "./shared";
import { extractAuthHeaders } from "./shared";

const logger = createLogger("sidecar:stdio");

function narrowStdio(inst: SidecarInstance) {
  if (inst.state.mode !== "stdio") {
    throw new Error("Expected stdio mode state");
  }
  return inst.state;
}

export const stdioHandler: ModeHandler = {
  async setup(inst, telemetry, timeout) {
    const { definition: def, processManager } = inst;
    const state = narrowStdio(inst);

    await processManager.spawn();

    state.stdioBridge = new StdioBridge(def.stdio ?? {}, telemetry);

    const stdin = processManager.getStdin();
    const stdout = processManager.getStdout();
    if (!stdin || !stdout) {
      await processManager.stop();
      throw new SidecarError(
        `[${def.id}] Failed to obtain stdio streams from child process`,
        { isRetryable: false },
      );
    }

    state.stdioBridge.attach(stdin, stdout);

    const ready = await state.stdioBridge.waitForReady(timeout);
    logger.info("[%s] Sidecar stdio ready: %s", def.id, ready);
    if (!ready) {
      state.stdioBridge.destroy();
      await processManager.stop();
      throw SidecarError.startupFailed(def.command, timeout);
    }

    processManager.setHealthy();

    stdioHandler.startHealthChecks(inst, timeout, telemetry);

    logger.info("[%s] Sidecar ready (stdio mode)", def.id);
  },

  startHealthChecks(inst, timeout, _telemetry) {
    const { definition: def, processManager } = inst;
    const state = narrowStdio(inst);

    const callbacks = {
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

          const bridge = state.stdioBridge;
          if (bridge) {
            // Stop health checks and detach before restarting
            bridge.stopHealthCheck();
            bridge.detach();
            await processManager.restart();

            const newStdin = processManager.getStdin();
            const newStdout = processManager.getStdout();
            if (newStdin && newStdout) {
              bridge.attach(newStdin, newStdout);
              const ready = await bridge.waitForReady(timeout);
              if (ready) {
                processManager.setHealthy();
              }
            }

            // Resume health checking with the same callbacks
            bridge.startHealthCheck(callbacks);
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
    };

    state.stdioBridge?.startHealthCheck(callbacks);
  },

  injectRoutes(
    router: IAppRouter,
    inst: SidecarInstance,
    helpers: PluginRouteHelpers,
  ) {
    const state = narrowStdio(inst);
    const { definition: def, processManager } = inst;
    const getStatus = () => processManager.status;

    const subRouter = Router();
    subRouter.all("/*", async (req: IAppRequest, res) => {
      if (!state.stdioBridge) {
        res.status(503).json({ error: "Sidecar stdio bridge not ready" });
        return;
      }

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
        const result = await state.stdioBridge.sendRequest({
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

    const fullPath = `/api/${helpers.pluginName}/${def.id}/*`;
    helpers.registerEndpoint(`stdio:${def.id}`, fullPath);
  },

  teardown(inst) {
    const state = narrowStdio(inst);
    state.stdioBridge?.destroy();
  },
};

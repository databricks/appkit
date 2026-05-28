import type { BasePlugin } from "shared";
import { createLogger } from "../logging/logger";
import type { ServiceManager } from "./service-manager";

const log = createLogger("appkit.shutdown");

const FORCE_SHUTDOWN_MS = 15_000;

type GracefulServer = BasePlugin & {
  gracefulClose?: () => Promise<void>;
};

/**
 * SIGTERM/SIGINT: drain HTTP (if the server plugin exposes it), then stop core
 * services. Force-exits after {@link FORCE_SHUTDOWN_MS} if stuck; repeated
 * signals are ignored while a run is in flight.
 */
export function registerGracefulShutdownHandlers(
  serverPlugin: BasePlugin | undefined,
  services: ServiceManager,
): void {
  let running = false;

  const shutdown = async () => {
    if (running) return;
    running = true;

    const forceExit = setTimeout(() => {
      log.error(
        "Shutdown timed out after %dms; forcing exit",
        FORCE_SHUTDOWN_MS,
      );
      process.exit(1);
    }, FORCE_SHUTDOWN_MS);
    forceExit.unref();

    try {
      await maybeCloseServer(serverPlugin as GracefulServer | undefined);
      await services.stop();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      log.error("Shutdown failed: %O", err);
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  const onSignal = () => {
    void shutdown();
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

async function maybeCloseServer(
  serverPlugin: GracefulServer | undefined,
): Promise<void> {
  const close = serverPlugin?.gracefulClose;
  if (typeof close !== "function") return;
  await close.call(serverPlugin);
}

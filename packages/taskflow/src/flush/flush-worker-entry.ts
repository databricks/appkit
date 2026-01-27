/**
 * FlushWorker entry point for the forked process
 *
 * This file is executed in a child process spawned by the Flush manager.
 * It handles IPC communication and signal handling.
 */

import { createRepository, type RepositoryConfig } from "@/persistence";
import type { FlushConfig, IPCCommand, IPCMessage } from "./types";
import { noopHooks } from "@/observability";
import { FlushWorker } from "./flush-worker";

interface FlushWorkerConfig extends FlushConfig {
  repository: RepositoryConfig;
}

/**
 * Send a IPC message to the parent process
 */
function send(message: IPCMessage): void {
  if (process.send) process.send(message);
}

/**
 * Main entry point for the flush worker process
 */
async function main(): Promise<void> {
  // parse configuration from environment
  const configJson = process.env.FLUSH_CONFIG;
  if (!configJson) {
    send({
      type: "error",
      payload: "FLUSH_CONFIG environment variable not set",
    });
    process.exit(1);
  }

  let config: FlushWorkerConfig;
  try {
    config = JSON.parse(configJson) as FlushWorkerConfig;
  } catch (error) {
    send({ type: "error", payload: `Failed to parse FLUSH_CONFIG: ${error}` });
    process.exit(1);
  }

  // create repository (hooks not available in worker process)
  const repository = await createRepository(config.repository, noopHooks);
  const worker = new FlushWorker(config, repository, noopHooks);

  // handle IPC commands from parent
  process.on("message", async (command: IPCCommand) => {
    switch (command.type) {
      case "get-stats":
        send({ type: "stats", payload: worker.getStats() });
        break;
      case "shutdown":
        await worker.gracefulShutdown(command.payload.timeoutMs);
        send({ type: "shutdown-complete" });
        process.exit(0);
        break;
    }
  });

  // handle signals
  process.on("SIGTERM", async () => {
    await worker.gracefulShutdown();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await worker.gracefulShutdown();
    process.exit(0);
  });

  // handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error("[FlushWorker] Uncaught exception:", error);
    send({ type: "error", payload: String(error) });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[FlushWorker] Unhandled rejection:", reason);
    send({ type: "error", payload: String(reason) });
    process.exit(1);
  });

  // start the worker
  try {
    await worker.start();
    send({ type: "ready" });
  } catch (error) {
    console.error("[FlushWorker] Failed to start:", error);
    send({ type: "error", payload: String(error) });
    process.exit(1);
  }
}

// execute main
main().catch((error) => {
  console.error("[FlushWorker] Fatal error:", error);
  process.exit(1);
});

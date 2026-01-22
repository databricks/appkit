import type { Server as HTTPServer } from "node:http";
import type express from "express";
import { createLogger } from "../../logging/logger";
import type { DevFileReader } from "../../plugin/dev-reader";
import {
  hasDevQuery,
  isLocalDev,
  isRemoteTunnelAllowedByEnv,
  isRemoteTunnelAssetRequest,
} from "./gate";
import type { RemoteTunnelManager } from "./remote-tunnel-manager";

const logger = createLogger("server:remote-tunnel:controller");

/**
 * Controller for the remote tunnel
 *
 * - Reads files from the dev file reader
 * - Manages the remote tunnel manager
 * - Sets up the web socket
 * - Cleans up the remote tunnel
 */
export class RemoteTunnelController {
  private devFileReader: DevFileReader;
  private server?: HTTPServer;
  private manager: RemoteTunnelManager | null;
  private initPromise: Promise<RemoteTunnelManager | null> | null;
  private wsReady: boolean;

  constructor(devFileReader: DevFileReader) {
    this.devFileReader = devFileReader;
    this.manager = null;
    this.initPromise = null;
    this.wsReady = false;
  }

  /**
   * Set the server instance
   * @param server
   */
  setServer(server: HTTPServer) {
    this.server = server;
    this.maybeSetupWebSocket();
  }

  /** Check if the remote tunnel is active */
  isActive(): boolean {
    return this.manager != null;
  }

  /** Check if the remote tunnel is allowed by the environment */
  isAllowedByEnv(): boolean {
    return isRemoteTunnelAllowedByEnv();
  }

  /**
   * Middleware for the remote tunnel
   * - Hard blocks in local dev
   * - Blocks when not allowed by env
   * - Handles dev query and asset requests
   * @param req - the request
   * @param res - the response
   * @param next - the next function
   * @returns the next function
   */
  middleware: express.RequestHandler = async (req, res, next) => {
    // hard blocker in local dev
    if (isLocalDev()) return next();

    // if not allowed by env, block
    if (!this.isAllowedByEnv()) return next();

    const wantsDev = hasDevQuery(req);
    const wantsRemoteAssets = isRemoteTunnelAssetRequest(req);

    // if not wants dev and not wants remote assets, skip
    if (!wantsDev && !wantsRemoteAssets) return next();

    const manager = await this.getOrInitManager();
    // if no manager, skip
    if (!manager) return next();

    // dev query present, let manager handle it
    if (wantsDev) {
      return manager.devModeMiddleware()(req, res, next);
    }

    // otherwise, handle vite asset fetch paths through the tunnel
    try {
      await manager.assetMiddleware()(req, res);
    } catch (error) {
      next(error);
    }
  };

  /** Cleanup the remote tunnel */
  cleanup() {
    try {
      this.manager?.cleanup();
    } finally {
      this.manager = null;
      this.initPromise = null;
      this.wsReady = false;
    }
  }

  /**
   * Get or initialize the remote tunnel manager
   * - If the manager is already initialized, return it
   * - If the manager is not initialized, initialize it
   * - If the manager is not allowed by the environment, return null
   * @returns the remote tunnel manager
   */
  private async getOrInitManager(): Promise<RemoteTunnelManager | null> {
    if (this.manager) return this.manager;
    if (this.initPromise) return await this.initPromise;

    this.initPromise = (async () => {
      // double check gate
      if (isLocalDev() || !isRemoteTunnelAllowedByEnv()) return null;
      const mod = await import("./remote-tunnel-manager");
      const remoteTunnelManager = new mod.RemoteTunnelManager(
        this.devFileReader,
      );
      this.manager = remoteTunnelManager;

      // attach server + ws setup
      this.maybeSetupWebSocket();

      logger.debug("RemoteTunnel: initialized (on-demand)");
      return remoteTunnelManager;
    })();

    return this.initPromise;
  }

  /**
   * Setup the web socket
   * - If the server is not set, return
   * - If the manager is not set, return
   * - If the web socket is already setup, return
   * - Setup the web socket
   */
  private maybeSetupWebSocket() {
    if (!this.server) return;
    if (!this.manager) return;
    if (this.wsReady) return;

    this.manager.setServer(this.server);
    this.manager.setupWebSocket();
    this.wsReady = true;

    logger.debug("RemoteTunnel: web socket setup complete");
  }
}

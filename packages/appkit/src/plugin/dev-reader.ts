import { randomUUID } from "node:crypto";
import type { TunnelConnection } from "shared";
import { isRemoteTunnelAllowedByEnv } from "@/plugins/server/remote-tunnel/gate";
import { TunnelError } from "../errors";
import { createLogger } from "../logging/logger";

const logger = createLogger("plugin:dev-reader");

type TunnelConnectionGetter = (
  req: import("express").Request,
) => TunnelConnection | null;

/**
 * This class is used to read files from the local filesystem in dev mode
 * through the WebSocket tunnel.
 */
export class DevFileReader {
  private static instance: DevFileReader | null = null;
  private getTunnelForRequest: TunnelConnectionGetter | null = null;

  private constructor() {}

  static getInstance(): DevFileReader {
    if (!DevFileReader.instance) {
      DevFileReader.instance = new Proxy(new DevFileReader(), {
        /**
         * We proxy the reader to return a noop function if the remote server is disabled.
         */
        get(target, prop, receiver) {
          if (isRemoteTunnelAllowedByEnv()) {
            return Reflect.get(target, prop, receiver);
          }

          const value = Reflect.get(target, prop, receiver);

          if (typeof value === "function") {
            return function noop() {
              logger.debug("Noop: %s (remote server disabled)", String(prop));
              return Promise.resolve("");
            };
          }

          return value;
        },
        set(target, prop, value, receiver) {
          return Reflect.set(target, prop, value, receiver);
        },
      });
    }

    return DevFileReader.instance;
  }

  registerTunnelGetter(getter: TunnelConnectionGetter) {
    this.getTunnelForRequest = getter;
  }

  async readFile(
    filePath: string,
    req: import("express").Request,
  ): Promise<string> {
    if (!this.getTunnelForRequest) {
      throw TunnelError.getterNotRegistered();
    }
    const tunnel = this.getTunnelForRequest(req);

    if (!tunnel) {
      throw TunnelError.noConnection();
    }

    const { ws, pendingFileReads } = tunnel;
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFileReads.delete(requestId);
        reject(new Error(`File read timeout: ${filePath}`));
      }, 10000);

      pendingFileReads.set(requestId, { resolve, reject, timeout });

      ws.send(
        JSON.stringify({
          type: "file:read",
          requestId,
          path: filePath,
        }),
      );
    });
  }

  async readdir(
    dirPath: string,
    req: import("express").Request,
  ): Promise<string[]> {
    if (!this.getTunnelForRequest) {
      throw TunnelError.getterNotRegistered();
    }
    const tunnel = this.getTunnelForRequest(req);

    if (!tunnel) {
      throw TunnelError.noConnection();
    }

    const { ws, pendingFileReads } = tunnel;
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFileReads.delete(requestId);
        reject(new Error(`Directory read timeout: ${dirPath}`));
      }, 10000);

      pendingFileReads.set(requestId, {
        resolve: (data: string) => {
          try {
            const files = JSON.parse(data);
            // Validate it's an array of strings
            if (!Array.isArray(files)) {
              reject(
                new Error(
                  "Invalid directory listing format: expected array, got " +
                    typeof files,
                ),
              );
              return;
            }
            if (!files.every((f) => typeof f === "string")) {
              reject(
                new Error(
                  "Invalid directory listing format: expected array of strings",
                ),
              );
              return;
            }
            resolve(files);
          } catch (error) {
            reject(
              new Error(
                `Failed to parse directory listing: ${(error as Error).message}`,
              ),
            );
          }
        },
        reject,
        timeout,
      });

      ws.send(
        JSON.stringify({
          type: "dir:list",
          requestId,
          path: dirPath,
        }),
      );
    });
  }
}

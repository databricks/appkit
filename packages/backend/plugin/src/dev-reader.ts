import { randomUUID } from "node:crypto";
import type { TunnelConnection } from "@databricks-apps/types";
import { isRemoteServerEnabled } from "@databricks-apps/utils";

type TunnelConnectionGetter = (
  req: import("express").Request
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
          if (isRemoteServerEnabled()) {
            return Reflect.get(target, prop, receiver);
          }

          const value = Reflect.get(target, prop, receiver);

          if (typeof value === "function") {
            return function noop() {
              console.info(`Noop: ${String(prop)} (remote server disabled)`);
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
    req: import("express").Request
  ): Promise<string> {
    if (!this.getTunnelForRequest) {
      throw new Error(
        "Tunnel getter not registered for DevFileReader singleton"
      );
    }
    const tunnel = this.getTunnelForRequest(req);

    if (!tunnel) {
      throw new Error("No tunnel connection available for file read");
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
        })
      );
    });
  }
}

import { type Client, createClient } from "@connectrpc/connect";
import type { ServiceType } from "@connectrpc/connect";
import {
  createConnectTransport,
  createGrpcTransport,
} from "@connectrpc/connect-node";
import { createLogger } from "../../logging/logger";
import type { GrpcClientOptions } from "./types";

const logger = createLogger("proto:grpc-client");

/**
 * Factory for creating typed gRPC/Connect clients.
 *
 * Creates clients that communicate with gRPC services using the appropriate
 * transport protocol:
 * - **connect** (default): Connect protocol over HTTP/1.1 — ideal for
 *   communicating with appkit servers in shared mode.
 * - **grpc**: Native gRPC over HTTP/2 — for standalone gRPC servers.
 * - **grpc-web**: gRPC-Web protocol — for browser clients.
 */
export class GrpcClientFactory {
  private defaultTimeout: number;

  constructor(defaultTimeout = 30000) {
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Create a typed gRPC client for a service.
   *
   * @param service - The Connect ServiceType descriptor (generated from .proto)
   * @param target - The target URL (e.g. "http://localhost:8000/api/proto/connect" or "http://grpc-server:50051")
   * @param options - Client configuration options
   * @returns A fully typed client for the service
   *
   * @example
   * ```typescript
   * import { JobDataService } from "shared/proto/appkit/v1/services_pb";
   *
   * const client = factory.create(
   *   JobDataService,
   *   "http://localhost:8000/api/proto/connect",
   * );
   *
   * const result = await client.getJobResult({ jobRunId: "run-123" });
   * ```
   */
  create<T extends ServiceType>(
    service: T,
    target: string,
    options?: GrpcClientOptions,
  ): Client<T> {
    const transportType = options?.transport ?? "connect";
    const timeout = options?.timeout ?? this.defaultTimeout;

    logger.debug(
      'Creating %s client for service "%s" targeting %s',
      transportType,
      service.typeName,
      target,
    );

    const transportOptions = {
      baseUrl: target,
      httpVersion: "1.1" as const,
      ...(options?.headers && {
        interceptors: [
          (next: any) => async (req: any) => {
            for (const [key, value] of Object.entries(options.headers!)) {
              req.header.set(key, value);
            }
            return next(req);
          },
        ],
      }),
    };

    const transport =
      transportType === "grpc"
        ? createGrpcTransport({
            ...transportOptions,
            httpVersion: "2",
          })
        : createConnectTransport(transportOptions);

    return createClient(service, transport);
  }
}

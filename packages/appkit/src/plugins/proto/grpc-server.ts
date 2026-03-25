import http2 from "node:http2";
import type { ServiceImpl, ServiceType } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { IAppRouter } from "shared";
import { createLogger } from "../../logging/logger";
import {
  DEFAULT_GRPC_PORT,
  DEFAULT_MAX_MESSAGE_SIZE,
  SHUTDOWN_TIMEOUT_MS,
} from "./defaults";
import type { GrpcServerOptions } from "./types";

const logger = createLogger("proto:grpc-server");

interface RegisteredService {
  service: ServiceType;
  implementation: ServiceImpl<ServiceType>;
}

/**
 * Manages gRPC service registration and server lifecycle.
 *
 * Supports two modes:
 * - **Shared mode** (default): Mount Connect handlers on the Express router.
 *   Services are available at /api/proto/connect/{ServiceName}/{MethodName}
 *   over HTTP/1.1 using the Connect protocol (compatible with browser clients).
 *
 * - **Standalone mode**: Run a separate HTTP/2 server for native gRPC clients
 *   (Python grpcio, Go grpc-go, etc.) that require HTTP/2 framing.
 */
export class GrpcServer {
  private services: RegisteredService[] = [];
  private http2Server: http2.Http2Server | null = null;
  private options: GrpcServerOptions;

  constructor(options?: GrpcServerOptions) {
    this.options = options ?? {};
  }

  /**
   * Register a gRPC service implementation.
   *
   * @param service - The Connect ServiceType descriptor (generated from .proto)
   * @param implementation - The service implementation object
   */
  registerService<T extends ServiceType>(
    service: T,
    implementation: ServiceImpl<T>,
  ): void {
    const existing = this.services.find(
      (s) => s.service.typeName === service.typeName,
    );
    if (existing) {
      throw new Error(
        `Service "${service.typeName}" is already registered. Each service can only be registered once.`,
      );
    }

    this.services.push({
      service,
      implementation: implementation as ServiceImpl<ServiceType>,
    });

    logger.info('Registered gRPC service: "%s"', service.typeName);
  }

  /**
   * Get the list of registered service type names.
   */
  getRegisteredServices(): string[] {
    return this.services.map((s) => s.service.typeName);
  }

  /**
   * Mount Connect handlers on an Express router (shared mode).
   *
   * The Connect protocol uses standard HTTP/1.1 POST requests, making it
   * compatible with Express. Services become available under /connect/...
   */
  mountOnRouter(router: IAppRouter): void {
    if (this.services.length === 0) {
      logger.debug("No gRPC services registered, skipping router mount");
      return;
    }

    const handler = connectNodeAdapter({
      routes: (router) => {
        for (const { service, implementation } of this.services) {
          router.service(service, implementation);
        }
      },
    });

    // Mount the Connect handler under /connect/*
    router.all("/connect/*", (req, res, next) => {
      // Strip the /connect prefix for the Connect handler
      const originalUrl = req.url;
      req.url = req.url.replace(/^\/connect/, "") || "/";
      handler(req, res, () => {
        req.url = originalUrl;
        next();
      });
    });

    logger.info(
      "Mounted %d gRPC service(s) on Express router via Connect protocol",
      this.services.length,
    );
  }

  /**
   * Start a standalone HTTP/2 gRPC server.
   *
   * Required for native gRPC clients (Python, Go, Java) that use HTTP/2
   * framing. The Express shared mode only supports Connect/gRPC-Web over HTTP/1.1.
   *
   * @param port - Port to listen on. Default: 50051
   */
  async start(port?: number): Promise<void> {
    if (this.http2Server) {
      throw new Error("Standalone gRPC server is already running");
    }

    const listenPort = port ?? DEFAULT_GRPC_PORT;

    const handler = connectNodeAdapter({
      routes: (router) => {
        for (const { service, implementation } of this.services) {
          router.service(service, implementation);
        }
      },
    });

    this.http2Server = http2.createServer(handler);

    await new Promise<void>((resolve, reject) => {
      this.http2Server!.listen(listenPort, () => {
        logger.info(
          "Standalone gRPC server started on port %d with %d service(s)",
          listenPort,
          this.services.length,
        );
        resolve();
      });
      this.http2Server!.on("error", reject);
    });
  }

  /**
   * Gracefully stop the standalone HTTP/2 server.
   */
  async stop(): Promise<void> {
    if (!this.http2Server) return;

    const server = this.http2Server;
    this.http2Server = null;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn("gRPC server shutdown timed out, forcing close");
        server.close();
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      server.close(() => {
        clearTimeout(timeout);
        logger.info("Standalone gRPC server stopped");
        resolve();
      });
    });
  }

  /**
   * Whether the standalone server is currently running.
   */
  isRunning(): boolean {
    return this.http2Server !== null;
  }
}

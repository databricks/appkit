import type { BasePluginConfig } from "shared";
import type { ServiceType } from "@connectrpc/connect";

/** Configuration for the Proto/gRPC plugin. */
export interface IProtoConfig extends BasePluginConfig {
  /** Port for standalone gRPC server. If not set, shares the Express HTTP port. */
  grpcPort?: number;
  /** Run gRPC on a separate HTTP/2 server (required for native gRPC clients). Default: false */
  standalone?: boolean;
  /** gRPC server options. */
  serverOptions?: GrpcServerOptions;
  /** Pre-registered gRPC service implementations. */
  services?: ServiceRegistration[];
  /** Default timeout for gRPC calls in milliseconds. Default: 30000 */
  timeout?: number;
}

/** gRPC server tuning options. */
export interface GrpcServerOptions {
  /** Maximum incoming message size in bytes. Default: 4MB */
  maxReceiveMessageLength?: number;
  /** Maximum outgoing message size in bytes. Default: 4MB */
  maxSendMessageLength?: number;
  /** Keepalive ping interval in milliseconds. */
  keepaliveTimeMs?: number;
  /** Keepalive timeout in milliseconds. */
  keepaliveTimeoutMs?: number;
}

/** A gRPC service registration pairing a service definition with its implementation. */
export interface ServiceRegistration {
  /** The Connect service type descriptor (generated from .proto). */
  service: ServiceType;
  /** The implementation object. */
  implementation: any;
}

/** Options for creating a gRPC client. */
export interface GrpcClientOptions {
  /** Transport protocol. Default: "connect" */
  transport?: "connect" | "grpc" | "grpc-web";
  /** Request timeout in milliseconds. Overrides plugin-level timeout. */
  timeout?: number;
  /** Custom headers to send with every request. */
  headers?: Record<string, string>;
}

import { describe, expect, test, vi } from "vitest";
import { GrpcClientFactory } from "../grpc-client";

// Mock connect transports
vi.mock("@connectrpc/connect-node", () => ({
  createConnectTransport: vi.fn(() => ({ type: "connect" })),
  createGrpcTransport: vi.fn(() => ({ type: "grpc" })),
}));

vi.mock("@connectrpc/connect", () => ({
  createClient: vi.fn((_service: any, transport: any) => ({
    _transport: transport,
    _service,
  })),
}));

describe("GrpcClientFactory", () => {
  const mockService = {
    typeName: "appkit.v1.TestService",
    methods: {},
  } as any;

  test("creates a client with default connect transport", () => {
    const factory = new GrpcClientFactory();
    const client = factory.create(mockService, "http://localhost:8000") as any;

    expect(client._service).toBe(mockService);
    expect(client._transport).toEqual({ type: "connect" });
  });

  test("creates a client with grpc transport", () => {
    const factory = new GrpcClientFactory();
    const client = factory.create(mockService, "http://localhost:50051", {
      transport: "grpc",
    }) as any;

    expect(client._transport).toEqual({ type: "grpc" });
  });

  test("uses default timeout from constructor", () => {
    const factory = new GrpcClientFactory(5000);
    const client = factory.create(mockService, "http://localhost:8000");
    // Client created successfully with custom timeout
    expect(client).toBeDefined();
  });

  test("creates client with custom headers", () => {
    const factory = new GrpcClientFactory();
    const client = factory.create(mockService, "http://localhost:8000", {
      headers: { Authorization: "Bearer token" },
    });

    expect(client).toBeDefined();
  });
});

import { describe, expect, test, vi } from "vitest";
import { GrpcServer } from "../grpc-server";

// Mock connect-node adapter
vi.mock("@connectrpc/connect-node", () => ({
  connectNodeAdapter: vi.fn(() => vi.fn()),
}));

describe("GrpcServer", () => {
  const mockService = {
    typeName: "appkit.v1.TestService",
    methods: {},
  } as any;

  const mockImpl = {
    testMethod: vi.fn(),
  };

  test("registerService adds a service", () => {
    const server = new GrpcServer();
    server.registerService(mockService, mockImpl);
    expect(server.getRegisteredServices()).toEqual(["appkit.v1.TestService"]);
  });

  test("registerService throws on duplicate", () => {
    const server = new GrpcServer();
    server.registerService(mockService, mockImpl);
    expect(() => server.registerService(mockService, mockImpl)).toThrow(
      'Service "appkit.v1.TestService" is already registered',
    );
  });

  test("getRegisteredServices returns empty array initially", () => {
    const server = new GrpcServer();
    expect(server.getRegisteredServices()).toEqual([]);
  });

  test("getRegisteredServices returns all registered services", () => {
    const server = new GrpcServer();

    const service1 = { typeName: "appkit.v1.Service1", methods: {} } as any;
    const service2 = { typeName: "appkit.v1.Service2", methods: {} } as any;

    server.registerService(service1, {});
    server.registerService(service2, {});

    expect(server.getRegisteredServices()).toEqual([
      "appkit.v1.Service1",
      "appkit.v1.Service2",
    ]);
  });

  test("isRunning returns false initially", () => {
    const server = new GrpcServer();
    expect(server.isRunning()).toBe(false);
  });

  test("mountOnRouter does nothing when no services registered", () => {
    const server = new GrpcServer();
    const router = {
      all: vi.fn(),
    } as any;

    server.mountOnRouter(router);
    expect(router.all).not.toHaveBeenCalled();
  });

  test("mountOnRouter registers connect handler when services exist", () => {
    const server = new GrpcServer();
    server.registerService(mockService, mockImpl);

    const router = {
      all: vi.fn(),
    } as any;

    server.mountOnRouter(router);
    expect(router.all).toHaveBeenCalledWith("/connect/*", expect.any(Function));
  });

  test("stop resolves immediately when no server running", async () => {
    const server = new GrpcServer();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

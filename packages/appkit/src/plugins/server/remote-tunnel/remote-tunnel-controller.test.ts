import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { mockDevHandler, mockAssetHandler, mockManagerInstance } = vi.hoisted(
  () => {
    const devHandler = vi.fn((_req: any, _res: any, next: any) => next());
    const assetHandler = vi.fn(async (_req: any, _res: any) => {});
    const managerInstance = {
      devModeMiddleware: vi.fn(() => devHandler),
      assetMiddleware: vi.fn(() => assetHandler),
      setServer: vi.fn(),
      setupWebSocket: vi.fn(),
      cleanup: vi.fn(),
    };
    return {
      mockDevHandler: devHandler,
      mockAssetHandler: assetHandler,
      mockManagerInstance: managerInstance,
    };
  },
);

vi.mock("./remote-tunnel-manager", () => ({
  RemoteTunnelManager: vi.fn().mockImplementation(() => mockManagerInstance),
}));

import { RemoteTunnelController } from "./remote-tunnel-controller";
import { RemoteTunnelManager } from "./remote-tunnel-manager";

describe("RemoteTunnelController", () => {
  const originalEnv = { ...process.env };
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.DEBUG_REMOTE_TUNNEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("middleware hard-blocks in local dev (never initializes manager)", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABRICKS_CLIENT_SECRET = "x";

    const ctrl = new RemoteTunnelController({} as any);
    const next = vi.fn();

    await ctrl.middleware(
      { query: { dev: "" }, originalUrl: "/?dev", method: "GET" } as any,
      {} as any,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(RemoteTunnelManager).not.toHaveBeenCalled();
    expect(ctrl.isActive()).toBe(false);
  });

  test("middleware blocks when env disallows remote tunnel", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABRICKS_CLIENT_SECRET;

    const ctrl = new RemoteTunnelController({} as any);
    const next = vi.fn();

    await ctrl.middleware(
      { query: { dev: "" }, originalUrl: "/?dev", method: "GET" } as any,
      {} as any,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(RemoteTunnelManager).not.toHaveBeenCalled();
  });

  test("initializes manager on demand for dev query and calls devModeMiddleware", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABRICKS_CLIENT_SECRET = "x";

    const ctrl = new RemoteTunnelController({} as any);
    const next = vi.fn();

    await ctrl.middleware(
      {
        query: { dev: "" },
        originalUrl: "/?dev",
        path: "/",
        method: "GET",
      } as any,
      {} as any,
      next,
    );

    expect(RemoteTunnelManager).toHaveBeenCalledTimes(1);
    expect(mockManagerInstance.devModeMiddleware).toHaveBeenCalledTimes(1);
    expect(mockDevHandler).toHaveBeenCalled();
    expect(ctrl.isActive()).toBe(true);
  });

  test("initializes manager on demand for asset request and calls assetMiddleware", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABRICKS_CLIENT_SECRET = "x";

    const ctrl = new RemoteTunnelController({} as any);
    const next = vi.fn();

    await ctrl.middleware(
      {
        query: {},
        originalUrl: "/@vite/client",
        path: "/@vite/client",
        method: "GET",
      } as any,
      {} as any,
      next,
    );

    expect(RemoteTunnelManager).toHaveBeenCalledTimes(1);
    expect(mockManagerInstance.assetMiddleware).toHaveBeenCalledTimes(1);
    expect(mockAssetHandler).toHaveBeenCalled();
  });

  test("setServer before init hooks websocket after init", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABRICKS_CLIENT_SECRET = "x";

    const ctrl = new RemoteTunnelController({} as any);
    const server = {} as any;
    ctrl.setServer(server);

    await ctrl.middleware(
      {
        query: { dev: "" },
        originalUrl: "/?dev",
        path: "/",
        method: "GET",
      } as any,
      {} as any,
      vi.fn(),
    );

    expect(mockManagerInstance.setServer).toHaveBeenCalledWith(server);
    expect(mockManagerInstance.setupWebSocket).toHaveBeenCalledTimes(1);
  });

  test("cleanup calls manager.cleanup and resets state", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABRICKS_CLIENT_SECRET = "x";

    const ctrl = new RemoteTunnelController({} as any);

    await ctrl.middleware(
      {
        query: { dev: "" },
        originalUrl: "/?dev",
        path: "/",
        method: "GET",
      } as any,
      {} as any,
      vi.fn(),
    );

    expect(ctrl.isActive()).toBe(true);

    ctrl.cleanup();
    expect(mockManagerInstance.cleanup).toHaveBeenCalledTimes(1);
    expect(ctrl.isActive()).toBe(false);
  });

  afterEach(() => {
    consoleLogSpy.mockClear();
  });
});

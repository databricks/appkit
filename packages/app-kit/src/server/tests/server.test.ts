import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Use vi.hoisted for mocks that need to be available before module loading
const { mockHttpServer, mockExpressApp } = vi.hoisted(() => {
  const httpServer = {
    close: vi.fn((cb: any) => cb?.()),
    on: vi.fn(),
    address: vi.fn().mockReturnValue({ port: 8000 }),
  };

  const expressApp = {
    use: vi.fn().mockReturnThis(),
    get: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: any, _host: any, cb: any) => {
      cb?.();
      return httpServer;
    }),
    _router: {
      stack: [] as any[],
    },
  };

  return { mockHttpServer: httpServer, mockExpressApp: expressApp };
});

// Mock express
vi.mock("express", () => {
  const jsonMiddleware = vi.fn();
  const staticMiddleware = vi.fn();

  const expressFn: any = vi.fn(() => mockExpressApp);
  expressFn.json = vi.fn(() => jsonMiddleware);
  expressFn.static = vi.fn(() => staticMiddleware);
  expressFn.Router = vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    use: vi.fn(),
  }));

  return { default: expressFn };
});

// Mock dependencies before imports
vi.mock("../../telemetry", () => ({
  TelemetryManager: {
    getProvider: vi.fn().mockReturnValue({
      getTracer: vi.fn().mockReturnValue({ startActiveSpan: vi.fn() }),
      getMeter: vi.fn().mockReturnValue({
        createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
        createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
      }),
      getLogger: vi.fn().mockReturnValue({ emit: vi.fn() }),
      registerInstrumentations: vi.fn(),
    }),
  },
  instrumentations: {
    http: {},
    express: {},
  },
}));

vi.mock("../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn().mockReturnValue({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    }),
  },
}));

vi.mock("../../utils", () => ({
  databricksClientMiddleware: vi
    .fn()
    .mockResolvedValue((_req: any, _res: any, next: any) => next()),
  isRemoteServerEnabled: vi.fn().mockReturnValue(false),
  validateEnv: vi.fn(),
  deepMerge: vi.fn((a, b) => ({ ...a, ...b })),
}));

vi.mock("../vite-dev-server", () => ({
  ViteDevServer: vi.fn().mockImplementation(() => ({
    setup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../static-server", () => ({
  StaticServer: vi.fn().mockImplementation(() => ({
    setup: vi.fn(),
  })),
}));

vi.mock("../remote-tunnel-manager", () => ({
  RemoteTunnelManager: vi.fn().mockImplementation(() => ({
    setServer: vi.fn(),
    setup: vi.fn(),
    setupWebSocket: vi.fn(),
    cleanup: vi.fn(),
  })),
}));

vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
}));

// Mock fs for findStaticPath
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
  },
}));

vi.mock("../utils", () => ({
  getRoutes: vi.fn().mockReturnValue([]),
}));

import fs from "node:fs";
import { isRemoteServerEnabled } from "../../utils";
import { RemoteTunnelManager } from "../remote-tunnel-manager";
import { StaticServer } from "../static-server";
import { ViteDevServer } from "../vite-dev-server";
import { ServerPlugin } from "../index";

describe("ServerPlugin", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();

    // Reset mock router stack for health endpoint test
    mockExpressApp._router.stack = [];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("constructor", () => {
    test("should initialize with default config", () => {
      const plugin = new ServerPlugin({});

      expect(plugin.name).toBe("server");
      expect(plugin.envVars).toEqual(["DATABRICKS_APP_PORT", "FLASK_RUN_HOST"]);
    });

    test("should use provided config values", () => {
      const plugin = new ServerPlugin({
        port: 3000,
        host: "127.0.0.1",
        autoStart: false,
      });

      const config = plugin.getConfig();
      expect(config.port).toBe(3000);
      expect(config.host).toBe("127.0.0.1");
      expect(config.autoStart).toBe(false);
    });
  });

  describe("DEFAULT_CONFIG", () => {
    test("should have correct default values", () => {
      expect(ServerPlugin.DEFAULT_CONFIG.autoStart).toBe(true);
      expect(ServerPlugin.DEFAULT_CONFIG.host).toBe("0.0.0.0");
      expect(ServerPlugin.DEFAULT_CONFIG.port).toBe(8000);
    });

    test("should use env vars when available", () => {
      expect(typeof ServerPlugin.DEFAULT_CONFIG.port).toBe("number");
      expect(typeof ServerPlugin.DEFAULT_CONFIG.host).toBe("string");
    });
  });

  describe("shouldAutoStart", () => {
    test("should return true when autoStart is true", () => {
      const plugin = new ServerPlugin({ autoStart: true });
      expect(plugin.shouldAutoStart()).toBe(true);
    });

    test("should return false when autoStart is false", () => {
      const plugin = new ServerPlugin({ autoStart: false });
      expect(plugin.shouldAutoStart()).toBe(false);
    });
  });

  describe("setup", () => {
    test("should call start when autoStart is true", async () => {
      const plugin = new ServerPlugin({ autoStart: true });
      const startSpy = vi.spyOn(plugin, "start").mockResolvedValue({} as any);

      await plugin.setup();

      expect(startSpy).toHaveBeenCalled();
    });

    test("should not call start when autoStart is false", async () => {
      const plugin = new ServerPlugin({ autoStart: false });
      const startSpy = vi.spyOn(plugin, "start").mockResolvedValue({} as any);

      await plugin.setup();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe("start", () => {
    test("should call listen on express app", async () => {
      const plugin = new ServerPlugin({ autoStart: false, port: 3000 });

      await plugin.start();

      expect(mockExpressApp.listen).toHaveBeenCalledWith(
        3000,
        expect.any(String),
        expect.any(Function),
      );
    });

    test("should setup ViteDevServer in development mode", async () => {
      process.env.NODE_ENV = "development";
      const plugin = new ServerPlugin({ autoStart: false });

      await plugin.start();

      expect(ViteDevServer).toHaveBeenCalled();
      const viteInstance = vi.mocked(ViteDevServer).mock.results[0].value;
      expect(viteInstance.setup).toHaveBeenCalled();
    });

    test("should setup StaticServer in production mode with valid static path", async () => {
      process.env.NODE_ENV = "production";
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const plugin = new ServerPlugin({ autoStart: false });

      await plugin.start();

      expect(StaticServer).toHaveBeenCalled();
      const staticInstance = vi.mocked(StaticServer).mock.results[0].value;
      expect(staticInstance.setup).toHaveBeenCalled();
    });

    test("should not setup StaticServer when no static path found", async () => {
      process.env.NODE_ENV = "production";
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const plugin = new ServerPlugin({ autoStart: false });

      await plugin.start();

      expect(StaticServer).not.toHaveBeenCalled();
    });

    test("should setup RemoteTunnelManager when remote serving is enabled", async () => {
      vi.mocked(isRemoteServerEnabled).mockReturnValue(true);

      const plugin = new ServerPlugin({ autoStart: false });

      await plugin.start();

      expect(RemoteTunnelManager).toHaveBeenCalled();
      const tunnelInstance =
        vi.mocked(RemoteTunnelManager).mock.results[0].value;
      expect(tunnelInstance.setServer).toHaveBeenCalled();
      expect(tunnelInstance.setup).toHaveBeenCalled();
      expect(tunnelInstance.setupWebSocket).toHaveBeenCalled();
    });

    test("should not setup RemoteTunnelManager when remote serving is disabled", async () => {
      vi.mocked(isRemoteServerEnabled).mockReturnValue(false);

      const plugin = new ServerPlugin({ autoStart: false });

      await plugin.start();

      expect(RemoteTunnelManager).not.toHaveBeenCalled();
    });
  });

  describe("extend", () => {
    test("should add extension function when autoStart is false", () => {
      const plugin = new ServerPlugin({ autoStart: false });
      const extensionFn = vi.fn();

      const result = plugin.extend(extensionFn);

      expect(result).toBe(plugin);
    });

    test("should throw when autoStart is true", () => {
      const plugin = new ServerPlugin({ autoStart: true });
      const extensionFn = vi.fn();

      expect(() => plugin.extend(extensionFn)).toThrow(
        "Cannot extend server when autoStart is true.",
      );
    });

    test("should call extension functions during start", async () => {
      const plugin = new ServerPlugin({ autoStart: false });
      const extensionFn = vi.fn();

      plugin.extend(extensionFn);
      await plugin.start();

      expect(extensionFn).toHaveBeenCalled();
    });
  });

  describe("getServer", () => {
    test("should throw when autoStart is true", () => {
      const plugin = new ServerPlugin({ autoStart: true });

      expect(() => plugin.getServer()).toThrow(
        "Cannot get server when autoStart is true.",
      );
    });

    test("should throw when server not started", () => {
      const plugin = new ServerPlugin({ autoStart: false });

      expect(() => plugin.getServer()).toThrow(
        "Server not started. Please start the server first by calling the start() method.",
      );
    });

    test("should return server after start", async () => {
      const plugin = new ServerPlugin({ autoStart: false });

      await plugin.start();
      const server = plugin.getServer();

      expect(server).toBe(mockHttpServer);
    });
  });

  describe("getConfig", () => {
    test("should return config without plugins", () => {
      const mockPlugin = { name: "test" } as any;
      const plugin = new ServerPlugin({
        port: 3000,
        plugins: { test: mockPlugin },
      });

      const config = plugin.getConfig();

      expect(config.port).toBe(3000);
      expect(config.plugins).toBeUndefined();
    });
  });

  describe("isRemoteServingEnabled", () => {
    test("should return value from isRemoteServerEnabled util", () => {
      vi.mocked(isRemoteServerEnabled).mockReturnValue(true);
      const plugin = new ServerPlugin({ autoStart: false });

      expect(plugin.isRemoteServingEnabled()).toBe(true);

      vi.mocked(isRemoteServerEnabled).mockReturnValue(false);
      expect(plugin.isRemoteServingEnabled()).toBe(false);
    });
  });
});

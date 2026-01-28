import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Use vi.hoisted for mocks that need to be available before module loading
const {
  mockHttpServer,
  mockExpressApp,
  mockRemoteTunnelControllerMiddleware,
  mockRemoteTunnelControllerInstance,
} = vi.hoisted(() => {
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

  const remoteTunnelControllerMiddleware = vi.fn(
    (_req: any, _res: any, next: any) => next(),
  );
  const remoteTunnelControllerInstance = {
    middleware: remoteTunnelControllerMiddleware,
    setServer: vi.fn(),
    cleanup: vi.fn(),
    isAllowedByEnv: vi.fn().mockReturnValue(false),
    isActive: vi.fn().mockReturnValue(false),
  };

  return {
    mockHttpServer: httpServer,
    mockExpressApp: expressApp,
    mockRemoteTunnelControllerMiddleware: remoteTunnelControllerMiddleware,
    mockRemoteTunnelControllerInstance: remoteTunnelControllerInstance,
  };
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
  validateEnv: vi.fn(),
  deepMerge: vi.fn((a, b) => ({ ...a, ...b })),
}));

vi.mock("../vite-dev-server", () => ({
  ViteDevServer: vi.fn().mockImplementation(() => ({
    setup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock logger for testing log output
const { mockLoggerDebug, mockLoggerInfo, mockLoggerWarn, mockLoggerError } =
  vi.hoisted(() => ({
    mockLoggerDebug: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  }));
vi.mock("../../logging/logger", () => ({
  createLogger: vi.fn(() => ({
    debug: mockLoggerDebug,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    event: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      setComponent: vi.fn().mockReturnThis(),
      setContext: vi.fn().mockReturnThis(),
      setUser: vi.fn().mockReturnThis(),
      setExecution: vi.fn().mockReturnThis(),
      setError: vi.fn().mockReturnThis(),
    })),
  })),
}));

vi.mock("../static-server", () => ({
  StaticServer: vi.fn().mockImplementation(() => ({
    setup: vi.fn(),
  })),
}));

vi.mock("../remote-tunnel/remote-tunnel-controller", () => ({
  RemoteTunnelController: vi.fn().mockImplementation(() => {
    return mockRemoteTunnelControllerInstance;
  }),
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
import express from "express";
import { ServerPlugin } from "../index";
import { RemoteTunnelController } from "../remote-tunnel/remote-tunnel-controller";
import { StaticServer } from "../static-server";
import { ViteDevServer } from "../vite-dev-server";

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

  describe("_shouldAutoStart", () => {
    test("should return true when autoStart is true", () => {
      const plugin = new ServerPlugin({ autoStart: true });
      expect(plugin._shouldAutoStart()).toBe(true);
    });

    test("should return false when autoStart is false", () => {
      const plugin = new ServerPlugin({ autoStart: false });
      expect(plugin._shouldAutoStart()).toBe(false);
    });
  });

  describe("_setup", () => {
    test("should call start when autoStart is true", async () => {
      const plugin = new ServerPlugin({ autoStart: true });
      const startSpy = vi.spyOn(plugin, "start").mockResolvedValue({} as any);

      await plugin._setup();

      expect(startSpy).toHaveBeenCalled();
    });

    test("should not call start when autoStart is false", async () => {
      const plugin = new ServerPlugin({ autoStart: false });
      const startSpy = vi.spyOn(plugin, "start").mockResolvedValue({} as any);

      await plugin._setup();

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

    test("should register RemoteTunnelController middleware and set server", async () => {
      const plugin = new ServerPlugin({ autoStart: false });

      await plugin.start();

      expect(RemoteTunnelController).toHaveBeenCalledTimes(1);
      expect(mockExpressApp.use).toHaveBeenCalledWith(
        mockRemoteTunnelControllerMiddleware,
      );
      expect(mockRemoteTunnelControllerInstance.setServer).toHaveBeenCalledWith(
        mockHttpServer,
      );
    });

    test("extendRoutes registers plugin routes correctly", async () => {
      process.env.NODE_ENV = "production";

      const _injectRoutes = vi.fn();
      const plugins: any = {
        "test-plugin": {
          name: "test-plugin",
          _injectRoutes,
          _getEndpoints: vi.fn().mockReturnValue({}),
        },
      };

      const plugin = new ServerPlugin({ autoStart: false, plugins });
      await plugin.start();

      const routerFn = (express as any).Router as ReturnType<typeof vi.fn>;
      expect(routerFn).toHaveBeenCalledTimes(1);
      const routerInstance = routerFn.mock.results[0].value;

      expect(_injectRoutes).toHaveBeenCalledWith(routerInstance);
      expect(mockExpressApp.use).toHaveBeenCalledWith(
        "/api/test-plugin",
        routerInstance,
      );
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
        "Cannot extend server when autoStart is true",
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
        "Cannot get server when autoStart is true",
      );
    });

    test("should throw when server not started", () => {
      const plugin = new ServerPlugin({ autoStart: false });

      expect(() => plugin.getServer()).toThrow(
        "Server not started. Please start the server first by calling the start() method",
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

  describe("logStartupInfo", () => {
    test("logs remote tunnel controller disabled when missing", () => {
      mockLoggerDebug.mockClear();
      const plugin = new ServerPlugin({ autoStart: false });
      (plugin as any).remoteTunnelController = undefined;

      (plugin as any).logStartupInfo();

      expect(mockLoggerDebug).toHaveBeenCalledWith(
        "Remote tunnel: disabled (controller not initialized)",
      );
    });

    test("logs remote tunnel allowed/active when controller present", () => {
      mockLoggerDebug.mockClear();
      const plugin = new ServerPlugin({ autoStart: false });
      (plugin as any).remoteTunnelController = {
        isAllowedByEnv: () => true,
        isActive: () => true,
      };

      (plugin as any).logStartupInfo();

      expect(
        mockLoggerDebug.mock.calls.some((c) =>
          String(c[0]).includes("Remote tunnel:"),
        ),
      ).toBe(true);
    });
  });

  describe("findStaticPath", () => {
    test("returns first matching static path and logs it", () => {
      mockLoggerDebug.mockClear();
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return String(p).endsWith("dist/index.html");
      });

      const p = (ServerPlugin as any).findStaticPath();
      expect(String(p)).toContain("dist");
      expect(
        mockLoggerDebug.mock.calls.some((c) =>
          String(c[0]).includes("Static files: serving from"),
        ),
      ).toBe(true);
    });
  });

  describe("_gracefulShutdown", () => {
    test("aborts plugin operations (with error isolation) and closes server", async () => {
      vi.useFakeTimers();
      mockLoggerError.mockClear();
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(((_code?: number) => undefined) as any);

      const plugin = new ServerPlugin({
        autoStart: false,
        plugins: {
          ok: {
            name: "ok",
            _abortActiveOperations: vi.fn(),
          } as any,
          bad: {
            name: "bad",
            _abortActiveOperations: vi.fn(() => {
              throw new Error("boom");
            }),
          } as any,
        },
      });

      // pretend started
      (plugin as any).server = mockHttpServer;

      await (plugin as any)._gracefulShutdown();
      vi.runAllTimers();

      expect(mockLoggerError).toHaveBeenCalled();
      expect(mockHttpServer.close).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});

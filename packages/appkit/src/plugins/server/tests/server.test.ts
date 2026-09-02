import type { BasePlugin } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PluginContext } from "../../../core/plugin-context";

// Use vi.hoisted for mocks that need to be available before module loading
const {
  mockHttpServer,
  mockExpressApp,
  mockRemoteTunnelControllerMiddleware,
  mockRemoteTunnelControllerInstance,
  mockGetPort,
} = vi.hoisted(() => {
  const httpServer = {
    close: vi.fn((cb: any) => cb?.()),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
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

  const mockGetPort = vi.fn(
    async (opts?: { port?: number | Iterable<number>; host?: string }) => {
      if (opts?.port == null) return 8000;
      if (typeof opts.port === "number") return opts.port;
      for (const p of opts.port) return p;
      return 8000;
    },
  );

  return {
    mockHttpServer: httpServer,
    mockExpressApp: expressApp,
    mockRemoteTunnelControllerMiddleware: remoteTunnelControllerMiddleware,
    mockRemoteTunnelControllerInstance: remoteTunnelControllerInstance,
    mockGetPort,
  };
});

vi.mock("get-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("get-port")>();
  return {
    ...actual,
    default: mockGetPort,
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
vi.mock("../../../telemetry", () => ({
  TelemetryManager: {
    getInstance: vi.fn().mockReturnValue({
      shutdown: vi.fn().mockResolvedValue(undefined),
    }),
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

vi.mock("../../../utils", () => ({
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
vi.mock("../../../logging/logger", () => ({
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

// Mock fs for findStaticPath and manifest loading
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: actual.readFileSync,
    },
  };
});

vi.mock("../utils", () => ({
  getRoutes: vi.fn().mockReturnValue([]),
  printRoutes: vi.fn(),
}));

vi.mock("../client-config-sanitizer", () => ({
  sanitizeClientConfig: vi.fn((_name: string, config: any) => config),
}));

import fs from "node:fs";

import express from "express";

import { LifecycleManager } from "../../../core/lifecycle-manager";
import { sanitizeClientConfig } from "../client-config-sanitizer";
import { ServerPlugin } from "../index";
import { RemoteTunnelController } from "../remote-tunnel/remote-tunnel-controller";
import { StaticServer } from "../static-server";
import { ViteDevServer } from "../vite-dev-server";

function createContextWithPlugins(plugins: Record<string, any>): PluginContext {
  const ctx = new PluginContext();
  for (const [name, instance] of Object.entries(plugins)) {
    ctx.registerPlugin(name, instance as BasePlugin);
  }
  return ctx;
}

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
      });

      const config = plugin.getConfig();
      expect(config.port).toBe(3000);
      expect(config.host).toBe("127.0.0.1");
    });

    test("should throw when autoStart is passed in config", () => {
      expect(() => new ServerPlugin({ autoStart: true } as any)).toThrow(
        "server({ autoStart }) has been removed",
      );
    });
  });

  describe("DEFAULT_CONFIG", () => {
    test("should have correct default values", () => {
      expect(ServerPlugin.DEFAULT_CONFIG.host).toBe("0.0.0.0");
      expect(ServerPlugin.DEFAULT_CONFIG.port).toBe(8000);
    });

    test("should use env vars when available", () => {
      expect(typeof ServerPlugin.DEFAULT_CONFIG.port).toBe("number");
      expect(typeof ServerPlugin.DEFAULT_CONFIG.host).toBe("string");
    });
  });

  describe("setup", () => {
    test("should not start the server (createApp drives the start)", async () => {
      const plugin = new ServerPlugin({});
      const startSpy = vi.spyOn(plugin, "start").mockResolvedValue({} as any);

      await plugin.setup();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe("start", () => {
    test("should call listen on express app", async () => {
      const plugin = new ServerPlugin({ port: 3000 });

      await plugin.start();

      expect(mockExpressApp.listen).toHaveBeenCalledWith(
        3000,
        expect.any(String),
        expect.any(Function),
      );
    });

    test("uses get-port portNumbers in development when default preferred", async () => {
      process.env.NODE_ENV = "development";
      mockGetPort.mockResolvedValueOnce(8123);
      const plugin = new ServerPlugin({});

      await plugin.start();

      expect(mockGetPort).toHaveBeenCalledWith(
        expect.objectContaining({
          host: ServerPlugin.DEFAULT_CONFIG.host,
        }),
      );
      const opts = mockGetPort.mock.calls[0][0] as {
        port: Iterable<number>;
      };
      expect([...opts.port].slice(0, 2)).toEqual([
        ServerPlugin.DEFAULT_CONFIG.port,
        ServerPlugin.DEFAULT_CONFIG.port + 1,
      ]);
      expect(mockExpressApp.listen).toHaveBeenCalledWith(
        8123,
        expect.any(String),
        expect.any(Function),
      );
    });

    test("uses get-port portNumbers in development when explicit port preferred", async () => {
      process.env.NODE_ENV = "development";
      mockGetPort.mockResolvedValueOnce(9123);
      const plugin = new ServerPlugin({ port: 4000 });

      await plugin.start();

      expect(mockGetPort).toHaveBeenCalledWith(
        expect.objectContaining({
          host: ServerPlugin.DEFAULT_CONFIG.host,
        }),
      );
      const opts = mockGetPort.mock.calls[0][0] as {
        port: Iterable<number>;
      };
      expect([...opts.port].slice(0, 2)).toEqual([4000, 4001]);
      expect(mockExpressApp.listen).toHaveBeenCalledWith(
        9123,
        expect.any(String),
        expect.any(Function),
      );
    });

    test("does not use get-port outside development", async () => {
      process.env.NODE_ENV = "production";
      mockGetPort.mockClear();
      const plugin = new ServerPlugin({ port: 3000 });

      await plugin.start();

      expect(mockGetPort).not.toHaveBeenCalled();
      expect(mockExpressApp.listen).toHaveBeenCalledWith(
        3000,
        expect.any(String),
        expect.any(Function),
      );
    });

    test("logs info when dev preferred port was busy and another was picked", async () => {
      process.env.NODE_ENV = "development";
      mockLoggerInfo.mockClear();
      mockGetPort.mockResolvedValueOnce(8123);
      const plugin = new ServerPlugin({});

      await plugin.start();

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "Port %d was busy, picking %d",
        ServerPlugin.DEFAULT_CONFIG.port,
        8123,
      );
    });

    test("does not log busy info when dev preferred port was free", async () => {
      process.env.NODE_ENV = "development";
      mockLoggerInfo.mockClear();
      mockGetPort.mockResolvedValueOnce(ServerPlugin.DEFAULT_CONFIG.port);
      const plugin = new ServerPlugin({});

      await plugin.start();

      expect(mockLoggerInfo).not.toHaveBeenCalledWith(
        "Port %d was busy, picking %d",
        expect.any(Number),
        expect.any(Number),
      );
    });

    test("should setup ViteDevServer in development mode", async () => {
      process.env.NODE_ENV = "development";
      const plugin = new ServerPlugin({});

      await plugin.start();

      expect(ViteDevServer).toHaveBeenCalled();
      const viteInstance = vi.mocked(ViteDevServer).mock.results[0].value;
      expect(viteInstance.setup).toHaveBeenCalled();
    });

    test("should register RemoteTunnelController middleware and set server", async () => {
      const plugin = new ServerPlugin({});

      await plugin.start();

      expect(RemoteTunnelController).toHaveBeenCalledTimes(1);
      expect(mockExpressApp.use).toHaveBeenCalledWith(
        mockRemoteTunnelControllerMiddleware,
      );
      expect(mockRemoteTunnelControllerInstance.setServer).toHaveBeenCalledWith(
        mockHttpServer,
      );
    });

    test("should skip body parsing for paths declared by plugins", async () => {
      process.env.NODE_ENV = "production";

      const plugins: any = {
        files: {
          name: "files",
          injectRoutes: vi.fn(),
          getEndpoints: vi.fn().mockReturnValue({}),
          getSkipBodyParsingPaths: vi
            .fn()
            .mockReturnValue(new Set(["/api/files/upload"])),
        },
      };

      const plugin = new ServerPlugin({ plugins });
      await plugin.start();

      // Get the type function passed to express.json
      const jsonCall = vi.mocked(express.json).mock.calls[0][0] as any;
      const typeFn = jsonCall.type;

      // Should skip body parsing for the declared path
      expect(typeFn({ url: "/api/files/upload", headers: {} })).toBe(false);

      // Should skip body parsing for declared path with query string
      expect(typeFn({ url: "/api/files/upload?path=foo", headers: {} })).toBe(
        false,
      );

      // Should NOT skip body parsing for other routes (no hardcoded /upload check)
      expect(
        typeFn({
          url: "/api/other/upload",
          headers: { "content-type": "application/json" },
        }),
      ).toBe(true);

      // Should still parse JSON for normal routes
      expect(
        typeFn({
          url: "/api/analytics/query",
          headers: { "content-type": "application/json" },
        }),
      ).toBe(true);
    });

    test("extendRoutes registers plugin routes correctly", async () => {
      process.env.NODE_ENV = "production";

      const injectRoutes = vi.fn();
      const testPlugins: any = {
        "test-plugin": {
          name: "test-plugin",
          injectRoutes,
          getEndpoints: vi.fn().mockReturnValue({}),
        },
      };

      const plugin = new ServerPlugin({
        context: createContextWithPlugins(testPlugins),
      } as any);
      await plugin.start();

      const routerFn = (express as any).Router as ReturnType<typeof vi.fn>;
      expect(routerFn).toHaveBeenCalledTimes(1);
      const routerInstance = routerFn.mock.results[0].value;

      expect(injectRoutes).toHaveBeenCalledWith(routerInstance);
      expect(mockExpressApp.use).toHaveBeenCalledWith(
        "/api/test-plugin",
        routerInstance,
      );
    });

    test("extendRoutes collects clientConfig from plugins", async () => {
      process.env.NODE_ENV = "production";
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const plugins: any = {
        "plugin-a": {
          name: "plugin-a",
          injectRoutes: vi.fn(),
          getEndpoints: vi.fn().mockReturnValue({}),
          clientConfig: vi.fn().mockReturnValue({ featureX: true }),
        },
        "plugin-b": {
          name: "plugin-b",
          injectRoutes: vi.fn(),
          getEndpoints: vi.fn().mockReturnValue({}),
          clientConfig: vi.fn().mockReturnValue({}),
        },
        "plugin-c": {
          name: "plugin-c",
          injectRoutes: vi.fn(),
          getEndpoints: vi.fn().mockReturnValue({}),
        },
      };

      const plugin = new ServerPlugin({
        context: createContextWithPlugins(plugins),
      } as any);
      await plugin.start();

      expect(plugins["plugin-a"].clientConfig).toHaveBeenCalled();
      expect(plugins["plugin-b"].clientConfig).toHaveBeenCalled();

      expect(StaticServer).toHaveBeenCalledWith(
        mockExpressApp,
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ "plugin-a": { featureX: true } }),
      );
    });

    test("extendRoutes skips null clientConfig", async () => {
      process.env.NODE_ENV = "production";
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const plugins: any = {
        "plugin-null": {
          name: "plugin-null",
          injectRoutes: vi.fn(),
          getEndpoints: vi.fn().mockReturnValue({}),
          clientConfig: vi.fn().mockReturnValue(null),
        },
      };

      const plugin = new ServerPlugin({
        context: createContextWithPlugins(plugins),
      } as any);
      await plugin.start();

      expect(plugins["plugin-null"].clientConfig).toHaveBeenCalled();
      expect(StaticServer).toHaveBeenCalledWith(
        mockExpressApp,
        expect.any(String),
        expect.any(Object),
        {},
      );
    });

    test("extendRoutes logs and skips invalid clientConfig instead of crashing", async () => {
      process.env.NODE_ENV = "production";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const actualSanitizer = await vi.importActual<
        typeof import("../client-config-sanitizer")
      >("../client-config-sanitizer");
      vi.mocked(sanitizeClientConfig).mockImplementationOnce(
        actualSanitizer.sanitizeClientConfig,
      );

      const plugins: any = {
        "plugin-a": {
          name: "plugin-a",
          injectRoutes: vi.fn(),
          getEndpoints: vi.fn().mockReturnValue({}),
          clientConfig: vi.fn().mockReturnValue(true),
        },
      };

      const plugin = new ServerPlugin({
        context: createContextWithPlugins(plugins),
      } as any);
      await expect(plugin.start()).resolves.toBeDefined();
      expect(mockLoggerError).toHaveBeenCalledWith(
        "Plugin '%s' clientConfig() failed, skipping its config: %O",
        "plugin-a",
        expect.any(Error),
      );
    });

    test("should setup StaticServer in production mode with valid static path", async () => {
      process.env.NODE_ENV = "production";
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const plugin = new ServerPlugin({});

      await plugin.start();

      expect(StaticServer).toHaveBeenCalled();
      const staticInstance = vi.mocked(StaticServer).mock.results[0].value;
      expect(staticInstance.setup).toHaveBeenCalled();
    });

    test("should not setup StaticServer when no static path found", async () => {
      process.env.NODE_ENV = "production";
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const plugin = new ServerPlugin({});

      await plugin.start();

      expect(StaticServer).not.toHaveBeenCalled();
    });
  });

  describe("extend", () => {
    test("should add extension function and return plugin for chaining", () => {
      const plugin = new ServerPlugin({});
      const extensionFn = vi.fn();

      const result = plugin.extend(extensionFn);

      expect(result).toBe(plugin);
    });

    test("should call extension functions during start", async () => {
      const plugin = new ServerPlugin({});
      const extensionFn = vi.fn();

      plugin.extend(extensionFn);
      await plugin.start();

      expect(extensionFn).toHaveBeenCalled();
    });
  });

  describe("getServer", () => {
    test("should throw when server not started", () => {
      const plugin = new ServerPlugin({});

      expect(() => plugin.getServer()).toThrow(
        "Server not started. Please start the server first by calling the start() method",
      );
    });

    test("should return server after start", async () => {
      const plugin = new ServerPlugin({});

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
      const plugin = new ServerPlugin({});
      (plugin as any).remoteTunnelController = undefined;

      (plugin as any).logStartupInfo();

      expect(mockLoggerDebug).toHaveBeenCalledWith(
        "Remote tunnel: disabled (controller not initialized)",
      );
    });

    test("logs remote tunnel allowed/active when controller present", () => {
      mockLoggerDebug.mockClear();
      const plugin = new ServerPlugin({});
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

  describe("shutdown hooks", () => {
    beforeEach(() => {
      mockLoggerError.mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("abortActiveOperations() stops accepting connections and initiates close", () => {
      const plugin = new ServerPlugin({
        context: createContextWithPlugins({}),
      } as any);
      (plugin as any).server = mockHttpServer;

      plugin.abortActiveOperations();

      // Idle keep-alive sockets are dropped and close() is initiated so a
      // connected browser cannot pin the server open.
      expect(mockHttpServer.closeIdleConnections).toHaveBeenCalledTimes(1);
      expect(mockHttpServer.close).toHaveBeenCalledTimes(1);
      // The full socket teardown is deferred to the lifecycle hook.
      expect(mockHttpServer.closeAllConnections).not.toHaveBeenCalled();
    });

    test("abortActiveOperations() is a no-op on sockets when no server started", () => {
      const plugin = new ServerPlugin({
        context: createContextWithPlugins({}),
      } as any);

      expect(() => plugin.abortActiveOperations()).not.toThrow();
      expect(mockHttpServer.close).not.toHaveBeenCalled();
    });

    test("shutdown() drains the dev servers", async () => {
      const plugin = new ServerPlugin({
        context: createContextWithPlugins({}),
      } as any);
      const viteClose = vi.fn().mockResolvedValue(undefined);
      const tunnelCleanup = vi.fn();
      (plugin as any).viteDevServer = { close: viteClose };
      (plugin as any).remoteTunnelController = { cleanup: tunnelCleanup };

      await plugin.shutdown();

      expect(viteClose).toHaveBeenCalledTimes(1);
      expect(tunnelCleanup).toHaveBeenCalledTimes(1);
    });

    test("closeRemainingConnections() force-closes sockets and awaits the close", async () => {
      const plugin = new ServerPlugin({
        context: createContextWithPlugins({}),
      } as any);
      (plugin as any).server = mockHttpServer;

      // abort initiates the close and captures the serverClosed promise
      plugin.abortActiveOperations();
      await (plugin as any).closeRemainingConnections();

      expect(mockHttpServer.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(mockHttpServer.close).toHaveBeenCalledTimes(1);
    });

    test("closeRemainingConnections() does not hang if close() never completes", async () => {
      vi.useFakeTimers();
      // A server whose close callback never fires.
      const stuckServer = {
        ...mockHttpServer,
        close: vi.fn(),
        closeIdleConnections: vi.fn(),
        closeAllConnections: vi.fn(),
      };
      const plugin = new ServerPlugin({
        context: createContextWithPlugins({}),
      } as any);
      (plugin as any).server = stuckServer;

      plugin.abortActiveOperations();
      const done = (plugin as any).closeRemainingConnections();
      // Bounded by SERVER_CLOSE_TIMEOUT_MS (2s) even though close never fires.
      await vi.advanceTimersByTimeAsync(2_000);
      await done;

      expect(stuckServer.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    test("start() registers closeRemainingConnections on the 'shutdown' lifecycle event", async () => {
      const ctx = createContextWithPlugins({});
      const onLifecycleSpy = vi.spyOn(ctx, "onLifecycle");
      const plugin = new ServerPlugin({ context: ctx } as any);

      await plugin.start();

      expect(onLifecycleSpy).toHaveBeenCalledWith(
        "shutdown",
        expect.any(Function),
      );

      // Emitting the event drives the socket teardown end-to-end.
      await ctx.emitLifecycle("shutdown");
      expect(mockHttpServer.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    test("real LifecycleManager drives the ServerPlugin's socket teardown in order", async () => {
      // End-to-end across the contract seam: a real LifecycleManager driving a
      // real ServerPlugin + real PluginContext, with a peer plugin whose
      // shutdown() hook must land BETWEEN the server's closeIdle (abort phase)
      // and closeAll (lifecycle-emit phase). Mocking only one side would let a
      // dropped registration or phase reorder pass — this catches it.
      const order: string[] = [];
      mockHttpServer.closeIdleConnections.mockImplementationOnce(() => {
        order.push("closeIdle");
      });
      mockHttpServer.closeAllConnections.mockImplementationOnce(() => {
        order.push("closeAll");
      });

      const ctx = new PluginContext();
      const server = new ServerPlugin({ context: ctx } as any);
      ctx.registerPlugin("server", server as unknown as BasePlugin);
      ctx.registerPlugin("peer", {
        name: "peer",
        shutdown: vi.fn(async () => {
          order.push("peer-shutdown");
        }),
      } as unknown as BasePlugin);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
        _code?: number,
      ) => {
        order.push("exit");
        return undefined;
      }) as any);

      await server.start();
      // The manager is injected now; only `close()` is exercised here.
      await new LifecycleManager(ctx, {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as import("../../../cache").CacheManager).shutdown();

      // closeIdle fires in the abort phase, the peer drains next, closeAll only
      // fires in the later lifecycle-emit phase, then the process exits 0.
      expect(order).toEqual(["closeIdle", "peer-shutdown", "closeAll", "exit"]);
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });
  });
});

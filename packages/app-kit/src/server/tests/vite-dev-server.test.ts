import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Use vi.hoisted to define mock functions that can be used in vi.mock
const {
  mockExistsSync,
  mockReadFileSync,
  mockViteMiddlewares,
  mockTransformIndexHtml,
  mockSsrFixStacktrace,
  mockViteClose,
  mockCreateServer,
  mockLoadConfigFromFile,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockViteMiddlewares: { name: "viteMiddlewares" },
  mockTransformIndexHtml: vi.fn(),
  mockSsrFixStacktrace: vi.fn(),
  mockViteClose: vi.fn(),
  mockCreateServer: vi.fn(),
  mockLoadConfigFromFile: vi.fn(),
}));

// Mock fs
vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  },
}));

// Mock vite
vi.mock("vite", () => ({
  createServer: mockCreateServer,
  loadConfigFromFile: mockLoadConfigFromFile,
  mergeConfig: vi.fn((a, b) => ({ ...a, ...b })),
}));

// Mock @vitejs/plugin-react
vi.mock("@vitejs/plugin-react", () => ({
  default: vi.fn().mockReturnValue({ name: "react" }),
}));

// Mock mergeConfigDedup
vi.mock("@/utils", () => ({
  mergeConfigDedup: vi.fn((userConfig, coreConfig, _mergeConfig) => ({
    ...userConfig,
    ...coreConfig,
  })),
}));

import { ViteDevServer } from "../vite-dev-server";

describe("ViteDevServer", () => {
  let mockApp: any;
  let mockRes: any;
  let mockNext: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = {
      use: vi.fn(),
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    mockNext = vi.fn();

    // Default: client directory exists with vite.config.ts and index.html
    mockExistsSync.mockImplementation((p: string) => {
      return (
        p.includes("client/vite.config.ts") || p.includes("client/index.html")
      );
    });
    mockReadFileSync.mockReturnValue("<html><body></body></html>");
    mockTransformIndexHtml.mockResolvedValue(
      "<html><body>transformed</body></html>",
    );
    mockLoadConfigFromFile.mockResolvedValue({ config: {} });
    mockCreateServer.mockResolvedValue({
      middlewares: mockViteMiddlewares,
      transformIndexHtml: mockTransformIndexHtml,
      ssrFixStacktrace: mockSsrFixStacktrace,
      close: mockViteClose,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    test("should store express app", () => {
      const server = new ViteDevServer(mockApp);
      expect(server).toBeDefined();
    });
  });

  describe("setup", () => {
    test("should create Vite server with middleware mode", async () => {
      const server = new ViteDevServer(mockApp);

      await server.setup();

      expect(mockCreateServer).toHaveBeenCalledWith(
        expect.objectContaining({
          server: expect.objectContaining({
            middlewareMode: true,
          }),
        }),
      );
    });

    test("should load user vite config", async () => {
      const server = new ViteDevServer(mockApp);

      await server.setup();

      expect(mockLoadConfigFromFile).toHaveBeenCalledWith(
        { mode: "development", command: "serve" },
        undefined,
        expect.any(String),
      );
    });

    test("should register Vite middlewares", async () => {
      const server = new ViteDevServer(mockApp);

      await server.setup();

      expect(mockApp.use).toHaveBeenCalledWith(mockViteMiddlewares);
    });

    test("should register SPA fallback handler", async () => {
      const server = new ViteDevServer(mockApp);

      await server.setup();

      expect(mockApp.use).toHaveBeenCalledWith("*", expect.any(Function));
    });
  });

  describe("SPA fallback handler", () => {
    test("should skip API routes", async () => {
      const server = new ViteDevServer(mockApp);
      await server.setup();

      const fallbackHandler = mockApp.use.mock.calls.find(
        (call: any[]) => call[0] === "*",
      )[1];

      await fallbackHandler({ originalUrl: "/api/test" }, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test("should skip query routes", async () => {
      const server = new ViteDevServer(mockApp);
      await server.setup();

      const fallbackHandler = mockApp.use.mock.calls.find(
        (call: any[]) => call[0] === "*",
      )[1];

      await fallbackHandler({ originalUrl: "/query/test" }, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    test("should serve transformed index.html for non-API routes", async () => {
      const server = new ViteDevServer(mockApp);
      await server.setup();

      const fallbackHandler = mockApp.use.mock.calls.find(
        (call: any[]) => call[0] === "*",
      )[1];

      await fallbackHandler({ originalUrl: "/some/page" }, mockRes, mockNext);

      expect(mockTransformIndexHtml).toHaveBeenCalledWith(
        "/some/page",
        expect.any(String),
      );
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.set).toHaveBeenCalledWith({ "Content-Type": "text/html" });
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should handle errors with ssrFixStacktrace", async () => {
      const error = new Error("Transform error");
      mockTransformIndexHtml.mockRejectedValueOnce(error);

      const server = new ViteDevServer(mockApp);
      await server.setup();

      const fallbackHandler = mockApp.use.mock.calls.find(
        (call: any[]) => call[0] === "*",
      )[1];

      await fallbackHandler({ originalUrl: "/" }, mockRes, mockNext);

      expect(mockSsrFixStacktrace).toHaveBeenCalledWith(error);
      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe("findClientRoot", () => {
    test("should find client directory with vite.config.ts and index.html", async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return (
          p.includes("client/vite.config.ts") || p.includes("client/index.html")
        );
      });

      const server = new ViteDevServer(mockApp);
      await server.setup();

      expect(mockCreateServer).toHaveBeenCalledWith(
        expect.objectContaining({
          root: expect.stringContaining("client"),
        }),
      );
    });

    test("should find src directory with vite.config.ts and index.html", async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.includes("src/vite.config.ts") || p.includes("src/index.html");
      });

      const server = new ViteDevServer(mockApp);
      await server.setup();

      expect(mockCreateServer).toHaveBeenCalledWith(
        expect.objectContaining({
          root: expect.stringContaining("src"),
        }),
      );
    });

    test("should throw error when no client directory found", async () => {
      mockExistsSync.mockReturnValue(false);

      const server = new ViteDevServer(mockApp);

      await expect(server.setup()).rejects.toThrow(
        "Could not find client directory",
      );
    });
  });

  describe("close", () => {
    test("should close Vite server", async () => {
      const server = new ViteDevServer(mockApp);
      await server.setup();

      await server.close();

      expect(mockViteClose).toHaveBeenCalled();
    });

    test("should handle close when vite not initialized", async () => {
      const server = new ViteDevServer(mockApp);

      await expect(server.close()).resolves.not.toThrow();
    });
  });
});

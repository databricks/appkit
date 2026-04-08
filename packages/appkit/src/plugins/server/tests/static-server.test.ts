import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock fs
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi
      .fn()
      .mockReturnValue(
        "<!DOCTYPE html><html><head></head><body><div id='root'></div></body></html>",
      ),
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([]),
  },
}));

// Mock express.static
vi.mock("express", () => ({
  default: {
    static: vi
      .fn()
      .mockReturnValue((_req: any, _res: any, next: any) => next()),
  },
}));

// Mock getQueries and getConfigScript
vi.mock("../utils", () => ({
  getQueries: vi.fn().mockReturnValue({ query1: "SELECT 1" }),
  getConfigScript: vi.fn().mockReturnValue(`
    <script id="__appkit__" type="application/json">
      {"appName":"my-test-app","queries":{"query1":"query1"},"endpoints":{},"plugins":{}}
    </script>
    <script>
      window.__appkit__ = JSON.parse(
        document.getElementById("__appkit__")?.textContent ?? "{}",
      );
    </script>
  `),
}));

import fs from "node:fs";
import express from "express";
import { StaticServer } from "../static-server";
import { getConfigScript } from "../utils";

describe("StaticServer", () => {
  let mockApp: any;
  let mockRes: any;
  let mockNext: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = {
      use: vi.fn(),
      get: vi.fn(),
    };

    mockRes = {
      send: vi.fn(),
    };

    mockNext = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    test("should store app and staticPath", () => {
      const staticPath = "/path/to/static";
      const server = new StaticServer(mockApp, staticPath);

      expect(server).toBeDefined();
    });
  });

  describe("setup", () => {
    test("should register express.static middleware", () => {
      const staticPath = "/path/to/static";
      const server = new StaticServer(mockApp, staticPath);

      server.setup();

      expect(express.static).toHaveBeenCalledWith(staticPath, { index: false });
      expect(mockApp.use).toHaveBeenCalled();
    });

    test("should register catch-all GET route for SPA fallback", () => {
      const server = new StaticServer(mockApp, "/static");

      server.setup();

      expect(mockApp.get).toHaveBeenCalledWith("*", expect.any(Function));
    });

    test("should skip API routes in SPA fallback", () => {
      const server = new StaticServer(mockApp, "/static");

      server.setup();

      const handler = mockApp.get.mock.calls[0][1];

      handler({ path: "/api/test" }, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.send).not.toHaveBeenCalled();
    });

    test("should skip query routes in SPA fallback", () => {
      const server = new StaticServer(mockApp, "/static");

      server.setup();

      const handler = mockApp.get.mock.calls[0][1];

      handler({ path: "/query/test" }, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.send).not.toHaveBeenCalled();
    });

    test("should serve index.html for non-API routes", () => {
      const server = new StaticServer(mockApp, "/static");

      server.setup();

      const handler = mockApp.get.mock.calls[0][1];

      handler({ path: "/some/page" }, mockRes, mockNext);

      expect(mockRes.send).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("serveIndex (via setup handler)", () => {
    test("should read index.html from static path", () => {
      const staticPath = "/my/static/path";
      const server = new StaticServer(mockApp, staticPath);

      server.setup();

      const handler = mockApp.get.mock.calls[0][1];
      handler({ path: "/" }, mockRes, mockNext);

      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join(staticPath, "index.html"),
        "utf-8",
      );
    });

    test("should inject config script into HTML", () => {
      const server = new StaticServer(mockApp, "/static");

      server.setup();

      const handler = mockApp.get.mock.calls[0][1];
      handler({ path: "/" }, mockRes, mockNext);

      const sentHtml = mockRes.send.mock.calls[0][0];
      expect(sentHtml).toContain('id="__appkit__"');
      expect(sentHtml).toContain('type="application/json"');
      expect(sentHtml).toContain("window.__appkit__ = JSON.parse");
    });

    test("should include appName in config", async () => {
      process.env.DATABRICKS_APP_NAME = "my-test-app";
      const actualUtils =
        await vi.importActual<typeof import("../utils")>("../utils");
      vi.mocked(getConfigScript).mockImplementationOnce(
        actualUtils.getConfigScript,
      );
      const server = new StaticServer(mockApp, "/static");

      server.setup();

      const handler = mockApp.get.mock.calls[0][1];
      handler({ path: "/" }, mockRes, mockNext);

      const sentHtml = mockRes.send.mock.calls[0][0];
      expect(sentHtml).toContain("my-test-app");

      delete process.env.DATABRICKS_APP_NAME;
    });

    test("should include queries in config", () => {
      const server = new StaticServer(mockApp, "/static");

      server.setup();

      const handler = mockApp.get.mock.calls[0][1];
      handler({ path: "/" }, mockRes, mockNext);

      expect(getConfigScript).toHaveBeenCalled();
      const sentHtml = mockRes.send.mock.calls[0][0];
      expect(sentHtml).toContain("query1");
    });
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    readdirSync: vi.fn(),
  },
}));

const { mockWebSocketServerCtor } = vi.hoisted(() => ({
  mockWebSocketServerCtor: vi.fn(),
}));

vi.mock("ws", () => ({
  WebSocketServer: mockWebSocketServerCtor.mockImplementation((_opts: any) => ({
    on: vi.fn(),
    emit: vi.fn(),
    handleUpgrade: vi.fn((_req: any, _socket: any, _head: any, cb: any) =>
      cb({}),
    ),
    close: vi.fn(),
  })),
}));

import { REMOTE_TUNNEL_ASSET_PREFIXES } from "./gate";
import { RemoteTunnelManager } from "./remote-tunnel-manager";

describe("RemoteTunnelManager (light unit tests)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockReturnValue("<html><body>OK</body></html>");
    mockExistsSync.mockReturnValue(false);
  });

  test("constructor registers tunnel getter and creates ws servers", () => {
    const devFileReader = { registerTunnelGetter: vi.fn() };
    new RemoteTunnelManager(devFileReader as any);

    expect(devFileReader.registerTunnelGetter).toHaveBeenCalledTimes(1);
    expect(mockWebSocketServerCtor).toHaveBeenCalledTimes(2);
  });

  test("setup registers dev middleware and asset middleware", () => {
    const mgr = new RemoteTunnelManager({
      registerTunnelGetter: vi.fn(),
    } as any);
    const app = { use: vi.fn() } as any;

    mgr.setup(app);

    expect(app.use).toHaveBeenCalledTimes(2);
    expect(app.use.mock.calls[0]).toHaveLength(1);
    expect(app.use.mock.calls[1][0]).toBe(REMOTE_TUNNEL_ASSET_PREFIXES);
    expect(typeof app.use.mock.calls[1][1]).toBe("function");
  });

  test("devModeMiddleware passes through when dev is undefined", async () => {
    const mgr = new RemoteTunnelManager({
      registerTunnelGetter: vi.fn(),
    } as any);
    const mw = mgr.devModeMiddleware();
    const next = vi.fn();

    await mw({ query: {}, path: "/", headers: {} } as any, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test("devModeMiddleware serves HTML + cookie for ?dev (blank)", async () => {
    const mgr = new RemoteTunnelManager({
      registerTunnelGetter: vi.fn(),
    } as any);
    const mw = mgr.devModeMiddleware();

    const res = {
      cookie: vi.fn(),
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as any;
    const next = vi.fn();

    await mw(
      {
        query: { dev: "" },
        path: "/",
        originalUrl: "/?dev",
        headers: { "x-forwarded-email": "x@y.com" },
      } as any,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith(
      "dev-tunnel-id",
      expect.any(String),
      expect.objectContaining({ sameSite: "lax" }),
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("window.__CONFIG__"),
    );
  });

  test("assetMiddleware returns 404 when tunnelId cannot be derived", async () => {
    const mgr = new RemoteTunnelManager({
      registerTunnelGetter: vi.fn(),
    } as any);
    const mw = mgr.assetMiddleware();

    const res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;

    await mw(
      { headers: {}, originalUrl: "/@vite/client", method: "GET" } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith("Tunnel not ready");
  });
});

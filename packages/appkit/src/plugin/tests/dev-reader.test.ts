import { describe, expect, test, vi, beforeEach } from "vitest";
import type { TunnelConnection } from "shared";
import { TunnelError } from "../../errors";

// Mock the gate to allow remote tunnel in tests
vi.mock("@/server/remote-tunnel/gate", () => ({
  isRemoteTunnelAllowedByEnv: () => true,
}));

import { DevFileReader } from "../dev-reader";

describe("DevFileReader", () => {
  let devFileReader: DevFileReader;
  let mockWs: any;
  let mockTunnel: TunnelConnection;

  beforeEach(() => {
    devFileReader = DevFileReader.getInstance();
    mockWs = {
      send: vi.fn(),
    };
    mockTunnel = {
      ws: mockWs,
      owner: "test-user@example.com",
      pendingFileReads: new Map(),
      pendingFetches: new Map(),
      pendingRequests: new Set(),
      approvedViewers: new Set(),
      rejectedViewers: new Set(),
      waitingForBinaryBody: null,
    };
  });

  describe("readdir", () => {
    test("should send dir:list message and resolve with parsed file list", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      // Start the readdir call
      const promise = devFileReader.readdir("config/queries", mockReq);

      // Simulate WebSocket response
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"dir:list"'),
      );

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      const { requestId } = sentMessage;

      // Get the pending request
      const pending = mockTunnel.pendingFileReads.get(requestId);
      expect(pending).toBeDefined();

      // Simulate CLI response
      const fileList = ["query1.sql", "query2.obo.sql", "query3.sql"];
      if (pending) {
        pending.resolve(JSON.stringify(fileList));
      }

      const result = await promise;
      expect(result).toEqual(fileList);
    });

    test("should validate that result is an array", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      const promise = devFileReader.readdir("config/queries", mockReq);

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      const { requestId } = sentMessage;
      const pending = mockTunnel.pendingFileReads.get(requestId);

      // Simulate invalid response (not an array)
      if (pending) {
        pending.resolve(JSON.stringify({ files: ["test.sql"] }));
      }

      await expect(promise).rejects.toThrow(
        "Invalid directory listing format: expected array",
      );
    });

    test("should validate that array contains only strings", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      const promise = devFileReader.readdir("config/queries", mockReq);

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      const { requestId } = sentMessage;
      const pending = mockTunnel.pendingFileReads.get(requestId);

      // Simulate invalid response (array with non-strings)
      if (pending) {
        pending.resolve(JSON.stringify(["test.sql", 123, "query.sql"]));
      }

      await expect(promise).rejects.toThrow(
        "Invalid directory listing format: expected array of strings",
      );
    });

    test("should reject on invalid JSON", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      const promise = devFileReader.readdir("config/queries", mockReq);

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      const { requestId } = sentMessage;
      const pending = mockTunnel.pendingFileReads.get(requestId);

      // Simulate invalid JSON response
      if (pending) {
        pending.resolve("not valid json {[");
      }

      await expect(promise).rejects.toThrow(
        "Failed to parse directory listing",
      );
    });

    test("should timeout after 10 seconds", async () => {
      vi.useFakeTimers();

      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      const promise = devFileReader.readdir("config/queries", mockReq);

      // Fast-forward time by 10 seconds
      vi.advanceTimersByTime(10000);

      await expect(promise).rejects.toThrow("Directory read timeout");

      vi.useRealTimers();
    });

    test("should throw error if tunnel getter not registered", async () => {
      const freshReader = new (DevFileReader as any)();
      const mockReq = {} as any;

      await expect(
        freshReader.readdir("config/queries", mockReq),
      ).rejects.toThrow(TunnelError.getterNotRegistered().message);
    });

    test("should throw error if no tunnel connection", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => null);

      await expect(
        devFileReader.readdir("config/queries", mockReq),
      ).rejects.toThrow(TunnelError.noConnection().message);
    });

    test("should clean up pending request on timeout", async () => {
      vi.useFakeTimers();

      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      const promise = devFileReader.readdir("config/queries", mockReq);

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      const { requestId } = sentMessage;

      expect(mockTunnel.pendingFileReads.has(requestId)).toBe(true);

      // Fast-forward time by 10 seconds
      vi.advanceTimersByTime(10000);

      await expect(promise).rejects.toThrow();

      // Verify cleanup
      expect(mockTunnel.pendingFileReads.has(requestId)).toBe(false);

      vi.useRealTimers();
    });

    test("should handle empty directory list", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      const promise = devFileReader.readdir("config/queries", mockReq);

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      const { requestId } = sentMessage;
      const pending = mockTunnel.pendingFileReads.get(requestId);

      // Simulate empty directory
      if (pending) {
        pending.resolve(JSON.stringify([]));
      }

      const result = await promise;
      expect(result).toEqual([]);
    });

    test("should send correct message format", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      devFileReader.readdir("config/queries", mockReq);

      expect(mockWs.send).toHaveBeenCalledTimes(1);

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sentMessage).toHaveProperty("type", "dir:list");
      expect(sentMessage).toHaveProperty("requestId");
      expect(sentMessage).toHaveProperty("path", "config/queries");
      expect(typeof sentMessage.requestId).toBe("string");
    });
  });

  describe("readFile - existing functionality", () => {
    test("should send file:read message", async () => {
      const mockReq = {} as any;
      devFileReader.registerTunnelGetter(() => mockTunnel);

      const promise = devFileReader.readFile(
        "config/queries/test.sql",
        mockReq,
      );

      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"file:read"'),
      );

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      const { requestId } = sentMessage;
      const pending = mockTunnel.pendingFileReads.get(requestId);

      // Simulate response
      if (pending) {
        pending.resolve("SELECT * FROM test");
      }

      const result = await promise;
      expect(result).toBe("SELECT * FROM test");
    });
  });
});

import type { Context } from "@opentelemetry/api";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EventRingBuffer } from "../buffers";
import { StreamRegistry } from "../stream-registry";
import type { StreamEntry } from "../types";
import { SSEErrorCode } from "../types";

/** Create a minimal mock StreamEntry for testing. */
function createMockStreamEntry(
  streamId: string,
  overrides: Partial<StreamEntry> = {},
): StreamEntry {
  return {
    streamId,
    generator: (async function* () {})(),
    eventBuffer: new EventRingBuffer(10),
    clients: new Set(),
    isCompleted: false,
    lastAccess: Date.now(),
    abortController: new AbortController(),
    traceContext: {} as Context,
    ...overrides,
  };
}

/** Create a mock response object that mimics express.Response for SSE writes. */
function createMockClient(writableEnded = false) {
  return {
    write: vi.fn().mockReturnValue(true),
    writableEnded,
  } as unknown as import("express").Response;
}

describe("StreamRegistry", () => {
  let registry: StreamRegistry;

  beforeEach(() => {
    registry = new StreamRegistry(3);
  });

  describe("add and get", () => {
    test("should add a stream and retrieve it by id", () => {
      const entry = createMockStreamEntry("stream-1");
      registry.add(entry);

      const result = registry.get("stream-1");

      expect(result).toBe(entry);
    });

    test("should return null for a non-existent stream", () => {
      const result = registry.get("non-existent");

      expect(result).toBeNull();
    });

    test("should add multiple streams and retrieve each", () => {
      const entry1 = createMockStreamEntry("stream-1");
      const entry2 = createMockStreamEntry("stream-2");
      const entry3 = createMockStreamEntry("stream-3");

      registry.add(entry1);
      registry.add(entry2);
      registry.add(entry3);

      expect(registry.get("stream-1")).toBe(entry1);
      expect(registry.get("stream-2")).toBe(entry2);
      expect(registry.get("stream-3")).toBe(entry3);
    });
  });

  describe("has", () => {
    test("should return true for an existing stream", () => {
      const entry = createMockStreamEntry("stream-1");
      registry.add(entry);

      expect(registry.has("stream-1")).toBe(true);
    });

    test("should return false for a non-existent stream", () => {
      expect(registry.has("non-existent")).toBe(false);
    });

    test("should return false after a stream is removed", () => {
      const entry = createMockStreamEntry("stream-1");
      registry.add(entry);
      registry.remove("stream-1");

      expect(registry.has("stream-1")).toBe(false);
    });
  });

  describe("remove", () => {
    test("should remove an existing stream", () => {
      const entry = createMockStreamEntry("stream-1");
      registry.add(entry);

      registry.remove("stream-1");

      expect(registry.get("stream-1")).toBeNull();
      expect(registry.size()).toBe(0);
    });

    test("should not throw when removing a non-existent stream", () => {
      expect(() => registry.remove("non-existent")).not.toThrow();
    });

    test("should only remove the specified stream", () => {
      const entry1 = createMockStreamEntry("stream-1");
      const entry2 = createMockStreamEntry("stream-2");
      registry.add(entry1);
      registry.add(entry2);

      registry.remove("stream-1");

      expect(registry.get("stream-1")).toBeNull();
      expect(registry.get("stream-2")).toBe(entry2);
      expect(registry.size()).toBe(1);
    });
  });

  describe("size", () => {
    test("should return 0 for an empty registry", () => {
      expect(registry.size()).toBe(0);
    });

    test("should track size as streams are added", () => {
      registry.add(createMockStreamEntry("stream-1"));
      expect(registry.size()).toBe(1);

      registry.add(createMockStreamEntry("stream-2"));
      expect(registry.size()).toBe(2);

      registry.add(createMockStreamEntry("stream-3"));
      expect(registry.size()).toBe(3);
    });

    test("should decrease when streams are removed", () => {
      registry.add(createMockStreamEntry("stream-1"));
      registry.add(createMockStreamEntry("stream-2"));

      registry.remove("stream-1");

      expect(registry.size()).toBe(1);
    });

    test("should not exceed capacity after eviction", () => {
      registry.add(createMockStreamEntry("stream-1", { lastAccess: 100 }));
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      // Adding a fourth stream to a capacity-3 registry triggers eviction
      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      expect(registry.size()).toBe(3);
    });
  });

  describe("capacity enforcement and eviction", () => {
    test("should evict the oldest stream when at capacity", () => {
      registry.add(createMockStreamEntry("stream-1", { lastAccess: 100 }));
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      // Adding a fourth should evict stream-1 (oldest lastAccess=100)
      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      expect(registry.has("stream-1")).toBe(false);
      expect(registry.has("stream-2")).toBe(true);
      expect(registry.has("stream-3")).toBe(true);
      expect(registry.has("stream-4")).toBe(true);
    });

    test("should evict the stream with the smallest lastAccess and abort it", () => {
      // When lastAccess order matches insertion order, the eviction logic
      // cleanly targets the LRU stream. The stream with the smallest
      // lastAccess is found and aborted.
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const ac3 = new AbortController();

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          abortController: ac1,
        }),
      );
      registry.add(
        createMockStreamEntry("stream-2", {
          lastAccess: 300,
          abortController: ac2,
        }),
      );
      registry.add(
        createMockStreamEntry("stream-3", {
          lastAccess: 200,
          abortController: ac3,
        }),
      );

      // Adding stream-4 triggers eviction. stream-1 has the smallest
      // lastAccess (100) so it should be targeted.
      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      expect(ac1.signal.aborted).toBe(true);
      expect(ac2.signal.aborted).toBe(false);
      expect(ac3.signal.aborted).toBe(false);
      expect(registry.has("stream-1")).toBe(false);
      expect(registry.has("stream-4")).toBe(true);
    });

    test("should exclude the stream being added from eviction", () => {
      // This tests the excludeStreamId parameter: if a stream with the same
      // ID as the one being added already exists and is the oldest, it should
      // still be excluded from eviction. In practice, the new stream won't be
      // in the registry yet when eviction runs, so excludeStreamId prevents
      // misidentification.
      registry.add(createMockStreamEntry("stream-1", { lastAccess: 100 }));
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      // Add stream with id "stream-1" again; eviction should skip "stream-1"
      // even though stream-1 has the oldest lastAccess, because it's the
      // excludeStreamId. stream-2 should be evicted instead.
      registry.add(createMockStreamEntry("stream-1", { lastAccess: 400 }));

      // stream-1 is updated (RingBuffer updates existing keys in place)
      expect(registry.has("stream-1")).toBe(true);
      // stream-2 should have been evicted as it was the oldest non-excluded
      expect(registry.has("stream-2")).toBe(false);
      expect(registry.has("stream-3")).toBe(true);
    });

    test("should abort the evicted stream's AbortController", () => {
      const abortController1 = new AbortController();
      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          abortController: abortController1,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      expect(abortController1.signal.aborted).toBe(true);
    });

    test("should abort with 'Stream evicted' reason", () => {
      const abortController1 = new AbortController();
      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          abortController: abortController1,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      expect(abortController1.signal.reason).toBe("Stream evicted");
    });
  });

  describe("eviction SSE broadcast", () => {
    test("should send STREAM_EVICTED error to all clients of evicted stream", () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      const clients = new Set([client1, client2]);

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          clients,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      // Trigger eviction of stream-1
      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      // Each client should have received the SSE error event
      for (const client of [client1, client2]) {
        expect(client.write).toHaveBeenCalledWith("event: error\n");
        expect(client.write).toHaveBeenCalledWith(
          `data: ${JSON.stringify({ error: "Stream evicted", code: SSEErrorCode.STREAM_EVICTED })}\n\n`,
        );
      }
    });

    test("should skip clients with writableEnded=true during eviction broadcast", () => {
      const activeClient = createMockClient(false);
      const endedClient = createMockClient(true);

      const clients = new Set([activeClient, endedClient]);

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          clients,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      // Active client should receive the error
      expect(activeClient.write).toHaveBeenCalledWith("event: error\n");

      // Ended client should NOT receive any writes
      expect(endedClient.write).not.toHaveBeenCalled();
    });

    test("should handle client.write throwing an error gracefully", () => {
      const throwingClient = createMockClient(false);
      (throwingClient.write as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("Connection reset");
        },
      );

      const normalClient = createMockClient(false);

      const clients = new Set([throwingClient, normalClient]);

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          clients,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      // Should not throw despite the throwing client
      expect(() => {
        registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));
      }).not.toThrow();

      // The normal client should still receive the error despite the other
      // client throwing. Note: both clients are in a Set, iteration order is
      // insertion order. The throwing client's error is caught per-client.
      // We verify the abort still happened (the overall eviction completed).
      expect(registry.has("stream-1")).toBe(false);
      expect(registry.has("stream-4")).toBe(true);
    });

    test("should send correct SSE error format with STREAM_EVICTED code", () => {
      const client = createMockClient();
      const clients = new Set([client]);

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          clients,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      // Verify the exact data payload
      const dataCall = (
        client.write as ReturnType<typeof vi.fn>
      ).mock.calls.find((call: unknown[]) =>
        (call[0] as string).startsWith("data:"),
      );
      expect(dataCall).toBeDefined();

      const payload = JSON.parse(
        (dataCall![0] as string).replace("data: ", "").trim(),
      );
      expect(payload).toEqual({
        error: "Stream evicted",
        code: "STREAM_EVICTED",
      });
    });

    test("should broadcast to multiple clients on the same evicted stream", () => {
      const client1 = createMockClient();
      const client2 = createMockClient();
      const client3 = createMockClient();

      const clients = new Set([client1, client2, client3]);

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          clients,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      // All three clients should have received exactly 2 write calls each
      // (one for "event: error\n" and one for the data line)
      for (const client of [client1, client2, client3]) {
        expect(client.write).toHaveBeenCalledTimes(2);
      }
    });

    test("should not broadcast if evicted stream has no clients", () => {
      const abortController = new AbortController();

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          clients: new Set(),
          abortController,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      // Should not throw even with no clients
      expect(() => {
        registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));
      }).not.toThrow();

      // Stream should still be evicted and aborted
      expect(registry.has("stream-1")).toBe(false);
      expect(abortController.signal.aborted).toBe(true);
    });
  });

  describe("clear", () => {
    test("should abort all streams and clear the registry", () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const ac3 = new AbortController();

      registry.add(createMockStreamEntry("stream-1", { abortController: ac1 }));
      registry.add(createMockStreamEntry("stream-2", { abortController: ac2 }));
      registry.add(createMockStreamEntry("stream-3", { abortController: ac3 }));

      registry.clear();

      expect(registry.size()).toBe(0);
      expect(ac1.signal.aborted).toBe(true);
      expect(ac2.signal.aborted).toBe(true);
      expect(ac3.signal.aborted).toBe(true);
    });

    test("should abort with 'Server shutdown' reason", () => {
      const ac = new AbortController();
      registry.add(createMockStreamEntry("stream-1", { abortController: ac }));

      registry.clear();

      expect(ac.signal.reason).toBe("Server shutdown");
    });

    test("should handle clearing an empty registry", () => {
      expect(() => registry.clear()).not.toThrow();
      expect(registry.size()).toBe(0);
    });

    test("should make all streams inaccessible after clear", () => {
      registry.add(createMockStreamEntry("stream-1"));
      registry.add(createMockStreamEntry("stream-2"));

      registry.clear();

      expect(registry.get("stream-1")).toBeNull();
      expect(registry.get("stream-2")).toBeNull();
      expect(registry.has("stream-1")).toBe(false);
      expect(registry.has("stream-2")).toBe(false);
    });

    test("should allow adding new streams after clear", () => {
      registry.add(createMockStreamEntry("stream-1"));
      registry.clear();

      const newEntry = createMockStreamEntry("stream-new");
      registry.add(newEntry);

      expect(registry.get("stream-new")).toBe(newEntry);
      expect(registry.size()).toBe(1);
    });
  });

  describe("edge cases", () => {
    test("should work with capacity of 1", () => {
      const smallRegistry = new StreamRegistry(1);
      const ac1 = new AbortController();

      smallRegistry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          abortController: ac1,
        }),
      );
      expect(smallRegistry.size()).toBe(1);

      smallRegistry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));

      expect(smallRegistry.size()).toBe(1);
      expect(smallRegistry.has("stream-1")).toBe(false);
      expect(smallRegistry.has("stream-2")).toBe(true);
      expect(ac1.signal.aborted).toBe(true);
    });

    test("should handle adding a stream with the same id (update)", () => {
      const entry1 = createMockStreamEntry("stream-1", {
        lastAccess: 100,
      });
      const entry2 = createMockStreamEntry("stream-1", {
        lastAccess: 200,
      });

      registry.add(entry1);
      registry.add(entry2);

      // The RingBuffer updates in place for same key
      expect(registry.size()).toBe(1);
      const retrieved = registry.get("stream-1");
      expect(retrieved?.lastAccess).toBe(200);
    });

    test("should handle sequential evictions correctly", () => {
      registry.add(createMockStreamEntry("stream-1", { lastAccess: 100 }));
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      // First eviction: stream-1 evicted
      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));
      expect(registry.has("stream-1")).toBe(false);

      // Second eviction: stream-2 evicted
      registry.add(createMockStreamEntry("stream-5", { lastAccess: 500 }));
      expect(registry.has("stream-2")).toBe(false);

      // stream-3, stream-4, stream-5 remain
      expect(registry.has("stream-3")).toBe(true);
      expect(registry.has("stream-4")).toBe(true);
      expect(registry.has("stream-5")).toBe(true);
      expect(registry.size()).toBe(3);
    });

    test("should not evict when under capacity", () => {
      const ac1 = new AbortController();
      registry.add(createMockStreamEntry("stream-1", { abortController: ac1 }));
      registry.add(createMockStreamEntry("stream-2"));

      // Only 2 streams in a capacity-3 registry, no eviction
      expect(registry.size()).toBe(2);
      expect(ac1.signal.aborted).toBe(false);
    });

    test("should handle mixed writable states during eviction", () => {
      const activeClient = createMockClient(false);
      const endedClient1 = createMockClient(true);
      const endedClient2 = createMockClient(true);

      const clients = new Set([endedClient1, activeClient, endedClient2]);

      registry.add(
        createMockStreamEntry("stream-1", {
          lastAccess: 100,
          clients,
        }),
      );
      registry.add(createMockStreamEntry("stream-2", { lastAccess: 200 }));
      registry.add(createMockStreamEntry("stream-3", { lastAccess: 300 }));

      registry.add(createMockStreamEntry("stream-4", { lastAccess: 400 }));

      // Only the active client should receive writes
      expect(activeClient.write).toHaveBeenCalledTimes(2);
      expect(endedClient1.write).not.toHaveBeenCalled();
      expect(endedClient2.write).not.toHaveBeenCalled();
    });
  });
});

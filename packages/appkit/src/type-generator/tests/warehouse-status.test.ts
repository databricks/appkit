import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getWarehouseState,
  type WarehouseState,
  waitUntilRunning,
} from "../warehouse-status";

/**
 * Build a minimal WorkspaceClient stub exposing only `warehouses.get`, the one
 * method these helpers touch. Cast through `unknown` to the SDK type so callers
 * type-check without us constructing a real client.
 */
function makeClient(get: ReturnType<typeof vi.fn>): WorkspaceClient {
  return { warehouses: { get } } as unknown as WorkspaceClient;
}

/** A warehouses.get resolution carrying a given lifecycle state. */
const stateResponse = (state: WarehouseState) => ({ state });

describe("getWarehouseState", () => {
  test("returns the .state from warehouses.get", async () => {
    const get = vi.fn().mockResolvedValue(stateResponse("RUNNING"));
    const client = makeClient(get);

    await expect(getWarehouseState(client, "wh-1")).resolves.toBe("RUNNING");
    expect(get).toHaveBeenCalledWith({ id: "wh-1" });
  });

  test("propagates errors from warehouses.get (does not catch)", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    const client = makeClient(get);

    await expect(getWarehouseState(client, "wh-1")).rejects.toThrow("boom");
  });
});

describe("waitUntilRunning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves RUNNING after polling through STARTING states", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(stateResponse("STARTING"))
      .mockResolvedValueOnce(stateResponse("STARTING"))
      .mockResolvedValueOnce(stateResponse("RUNNING"));
    const client = makeClient(get);

    const promise = waitUntilRunning(client, "wh-1", { maxMs: 60000 });

    // Drive the fake clock past each backoff delay (1000ms, then 2000ms) so the
    // subsequent polls fire. advanceTimersByTimeAsync also flushes the awaited
    // getWarehouseState microtasks between polls.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBe("RUNNING");
    expect(get).toHaveBeenCalledTimes(3);
  });

  test("resolves with a not-coming-up state without waiting (STOPPED)", async () => {
    const get = vi.fn().mockResolvedValue(stateResponse("STOPPED"));
    const client = makeClient(get);

    // First poll already returns STOPPED, so no timer advance is needed.
    await expect(
      waitUntilRunning(client, "wh-1", { maxMs: 60000 }),
    ).resolves.toBe("STOPPED");
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("STOPPED stays terminal when treatStoppedAsTransient is false", async () => {
    const get = vi.fn().mockResolvedValue(stateResponse("STOPPED"));
    const client = makeClient(get);

    // Explicit false mirrors the default: STOPPED is terminal, resolves at once.
    await expect(
      waitUntilRunning(client, "wh-1", {
        maxMs: 60000,
        treatStoppedAsTransient: false,
      }),
    ).resolves.toBe("STOPPED");
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("treatStoppedAsTransient polls through STOPPED until RUNNING", async () => {
    // A start was just issued, so the first poll still reports the stale STOPPED
    // before the start propagates. With the flag on we must NOT bail on it —
    // keep polling (STOPPED → STARTING → RUNNING) and resolve RUNNING.
    const get = vi
      .fn()
      .mockResolvedValueOnce(stateResponse("STOPPED"))
      .mockResolvedValueOnce(stateResponse("STARTING"))
      .mockResolvedValueOnce(stateResponse("RUNNING"));
    const client = makeClient(get);

    const promise = waitUntilRunning(client, "wh-1", {
      maxMs: 60000,
      treatStoppedAsTransient: true,
    });

    // Drive past each backoff (1000ms, then 2000ms) so the later polls fire.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBe("RUNNING");
    expect(get).toHaveBeenCalledTimes(3);
  });

  test("treatStoppedAsTransient still treats DELETED as terminal", async () => {
    const get = vi.fn().mockResolvedValue(stateResponse("DELETED"));
    const client = makeClient(get);

    // A deleted warehouse genuinely can't reach RUNNING, so even with the flag
    // on it resolves immediately with the observed state.
    await expect(
      waitUntilRunning(client, "wh-1", {
        maxMs: 60000,
        treatStoppedAsTransient: true,
      }),
    ).resolves.toBe("DELETED");
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("rejects when maxMs elapses while still STARTING", async () => {
    const get = vi.fn().mockResolvedValue(stateResponse("STARTING"));
    const client = makeClient(get);

    const promise = waitUntilRunning(client, "wh-1", { maxMs: 3000 });
    // Attach a rejection handler immediately so the eventual throw isn't an
    // unhandled rejection while we advance the clock.
    const settled = expect(promise).rejects.toThrow(
      /wh-1 did not reach RUNNING within 3000ms/,
    );

    // Push well past the 3000ms budget; exponential backoff (1000 + 2000 = 3000)
    // means the deadline check trips on the next iteration.
    await vi.advanceTimersByTimeAsync(10000);

    await settled;
  });

  test("stops immediately when the signal is already aborted", async () => {
    const get = vi.fn().mockResolvedValue(stateResponse("STARTING"));
    const client = makeClient(get);

    const controller = new AbortController();
    controller.abort();

    // The pre-loop abort check throws before the first poll, so warehouses.get
    // is never even called.
    await expect(
      waitUntilRunning(client, "wh-1", {
        maxMs: 60000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(get).not.toHaveBeenCalled();
  });

  test("stops promptly when aborted mid-wait", async () => {
    const get = vi.fn().mockResolvedValue(stateResponse("STARTING"));
    const client = makeClient(get);
    const controller = new AbortController();

    const promise = waitUntilRunning(client, "wh-1", {
      maxMs: 60000,
      signal: controller.signal,
    });
    const settled = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });

    // Flush only the first poll's microtask (advance 0, not the full 1000ms
    // backoff): the wait is now parked on its first backoff sleep, one poll in.
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);

    // Abort while parked between polls: the backoff sleep resolves immediately
    // via its abort listener, then the post-sleep abort check throws — so we
    // never issue a second poll.
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await settled;
    expect(get).toHaveBeenCalledTimes(1);
  });
});

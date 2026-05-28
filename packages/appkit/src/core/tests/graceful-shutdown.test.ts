import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
  },
}));

vi.mock("../../logging/logger", () => ({
  createLogger: () => mockLogger,
}));

import { registerGracefulShutdownHandlers } from "../graceful-shutdown";

type SignalListener = NodeJS.SignalsListener;

function makeServiceManager() {
  return {
    add: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    stop: vi.fn(async () => {}),
  } as unknown as import("../service-manager").ServiceManager & {
    stop: ReturnType<typeof vi.fn>;
  };
}

/**
 * Snapshot SIGTERM/SIGINT listeners before each test and surgically remove
 * anything that registered during the test. Avoids stepping on vitest's
 * own signal handlers.
 */
function captureNewSignalListeners(): () => void {
  const before = {
    SIGTERM: new Set(process.listeners("SIGTERM")),
    SIGINT: new Set(process.listeners("SIGINT")),
  };
  return () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].has(listener)) {
          process.removeListener(signal, listener as SignalListener);
        }
      }
    }
  };
}

function getRegisteredHandler(signal: "SIGTERM" | "SIGINT"): SignalListener {
  const listeners = process.listeners(signal);
  if (listeners.length === 0) {
    throw new Error(`No ${signal} listener registered`);
  }
  return listeners[listeners.length - 1] as SignalListener;
}

describe("registerGracefulShutdownHandlers", () => {
  let exitSpy: ReturnType<typeof vi.fn>;
  let cleanupListeners: () => void;

  beforeEach(() => {
    mockLogger.error.mockClear();
    cleanupListeners = captureNewSignalListeners();
    exitSpy = vi.fn();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitSpy(code);
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    cleanupListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("registers both SIGTERM and SIGINT handlers", () => {
    const services = makeServiceManager();
    registerGracefulShutdownHandlers(undefined, services);

    expect(() => getRegisteredHandler("SIGTERM")).not.toThrow();
    expect(() => getRegisteredHandler("SIGINT")).not.toThrow();
  });

  test("drains server, stops services in order, exits with 0", async () => {
    const gracefulClose = vi.fn(async () => {});
    const serverPlugin = { name: "server", gracefulClose } as never;
    const services = makeServiceManager();

    registerGracefulShutdownHandlers(serverPlugin, services);
    getRegisteredHandler("SIGTERM")("SIGTERM");

    // Yield twice: once for the async shutdown function to start, once for
    // its awaits (close + stop) to resolve through their microtask queues.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(gracefulClose).toHaveBeenCalledTimes(1);
    expect(services.stop).toHaveBeenCalledTimes(1);
    expect(gracefulClose.mock.invocationCallOrder[0]).toBeLessThan(
      (services.stop as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("server plugin without gracefulClose is skipped, services still stop", async () => {
    const services = makeServiceManager();
    const pluginWithoutClose = { name: "noop" } as never;

    registerGracefulShutdownHandlers(pluginWithoutClose, services);
    getRegisteredHandler("SIGTERM")("SIGTERM");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(services.stop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("repeated signals during shutdown are coalesced", async () => {
    let resolveClose!: () => void;
    const gracefulClose = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveClose = r;
        }),
    );
    const services = makeServiceManager();
    const serverPlugin = { name: "server", gracefulClose } as never;

    registerGracefulShutdownHandlers(serverPlugin, services);
    const handler = getRegisteredHandler("SIGTERM");

    handler("SIGTERM");
    handler("SIGTERM");
    handler("SIGTERM");
    await new Promise((r) => setImmediate(r));

    expect(gracefulClose).toHaveBeenCalledTimes(1);

    resolveClose();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(services.stop).toHaveBeenCalledTimes(1);
  });

  test("services.stop() failure logs and exits with 1", async () => {
    const services = makeServiceManager();
    (services.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );

    registerGracefulShutdownHandlers(undefined, services);
    getRegisteredHandler("SIGTERM")("SIGTERM");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Shutdown failed: %O",
      expect.any(Error),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("force-exits when shutdown hangs past FORCE_SHUTDOWN_MS", async () => {
    vi.useFakeTimers();
    const gracefulClose = vi.fn(() => new Promise<void>(() => {}));
    const services = makeServiceManager();
    const serverPlugin = { name: "server", gracefulClose } as never;

    registerGracefulShutdownHandlers(serverPlugin, services);
    getRegisteredHandler("SIGTERM")("SIGTERM");

    await Promise.resolve();
    vi.advanceTimersByTime(15_000);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown timed out"),
      15_000,
    );
  });
});

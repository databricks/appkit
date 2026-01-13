import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../logger";

describe("createLogger", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test("returns logger with all methods", () => {
    const logger = createLogger("test");

    expect(logger).toHaveProperty("debug");
    expect(logger).toHaveProperty("info");
    expect(logger).toHaveProperty("warn");
    expect(logger).toHaveProperty("error");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  test("info uses console.log with correct prefix", () => {
    const logger = createLogger("test-scope");

    logger.info("hello world");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[appkit:test-scope]",
      "hello world",
    );
  });

  test("warn uses console.warn with correct prefix", () => {
    const logger = createLogger("my-plugin");

    logger.warn("something is wrong");

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[appkit:my-plugin]",
      "something is wrong",
    );
  });

  test("error uses console.error with correct prefix", () => {
    const logger = createLogger("connector");

    logger.error("operation failed");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[appkit:connector]",
      "operation failed",
    );
  });

  test("formats string placeholders correctly", () => {
    const logger = createLogger("test");

    logger.info("User %s logged in", "alice");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[appkit:test]",
      "User alice logged in",
    );
  });

  test("formats number placeholders correctly", () => {
    const logger = createLogger("server");

    logger.info("Server running on port %d", 8080);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[appkit:server]",
      "Server running on port 8080",
    );
  });

  test("formats multiple placeholders", () => {
    const logger = createLogger("cache");

    logger.info("Cache hit for key %s, size: %d bytes", "user:123", 1024);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[appkit:cache]",
      "Cache hit for key user:123, size: 1024 bytes",
    );
  });

  test("formats object placeholders with %O", () => {
    const logger = createLogger("test");
    const obj = { id: 1, name: "test" };

    logger.error("Failed with context: %O", obj);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[appkit:test]",
      expect.stringContaining("id"),
    );
  });

  test("handles nested scope names", () => {
    const logger = createLogger("connectors:lakebase");

    logger.info("connected");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[appkit:connectors:lakebase]",
      "connected",
    );
  });

  test("handles messages without placeholders and extra args", () => {
    const logger = createLogger("test");

    logger.info("simple message", "extra", "args");

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[appkit:test]",
      "simple message extra args",
    );
  });
});

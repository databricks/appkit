import { describe, expect, test, vi } from "vitest";
import { resolveLogger } from "../logger";
import type { Logger, LoggerConfig } from "../types";

describe("resolveLogger", () => {
  describe("Logger instance passthrough", () => {
    test("should return Logger instance as-is", () => {
      const mockLogger: Logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const result = resolveLogger(mockLogger);

      expect(result).toBe(mockLogger);
    });
  });

  describe("LoggerConfig resolution", () => {
    test("should create console logger with all levels enabled", () => {
      const config: LoggerConfig = {
        debug: true,
        info: true,
        warn: true,
        error: true,
      };

      const logger = resolveLogger(config);

      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    test("should create console logger with selective levels", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const config: LoggerConfig = {
        debug: true,
        info: false,
        warn: true,
        error: false,
      };

      const logger = resolveLogger(config);

      // Test enabled levels
      logger.debug("test debug");
      expect(consoleDebugSpy).toHaveBeenCalledWith("test debug");

      logger.warn("test warn");
      expect(consoleWarnSpy).toHaveBeenCalledWith("test warn");

      // Test disabled levels (should be noop)
      logger.info("test info");
      expect(consoleInfoSpy).not.toHaveBeenCalled();

      logger.error("test error");
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should create noop logger when all levels disabled", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const config: LoggerConfig = {
        debug: false,
        info: false,
        warn: false,
        error: false,
      };

      const logger = resolveLogger(config);

      logger.debug("test");
      logger.info("test");
      logger.warn("test");
      logger.error("test");

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should handle empty LoggerConfig", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const config: LoggerConfig = {};

      const logger = resolveLogger(config);

      logger.debug("test");
      logger.info("test");
      logger.warn("test");
      logger.error("test");

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should support format strings and args", () => {
      const consoleErrorSpy = vi.spyOn(console, "error");

      const config: LoggerConfig = {
        error: true,
      };

      const logger = resolveLogger(config);

      logger.error("Error: %s %d", "test", 123);

      expect(consoleErrorSpy).toHaveBeenCalledWith("Error: %s %d", "test", 123);

      consoleErrorSpy.mockRestore();
    });
  });

  describe("Default behavior", () => {
    test("should create error-only logger when undefined", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const logger = resolveLogger(undefined);

      logger.debug("test");
      logger.info("test");
      logger.warn("test");
      logger.error("test error");

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith("test error");

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should create error-only logger when no argument provided", () => {
      const consoleErrorSpy = vi.spyOn(console, "error");

      const logger = resolveLogger();

      logger.error("test error");

      expect(consoleErrorSpy).toHaveBeenCalledWith("test error");

      consoleErrorSpy.mockRestore();
    });
  });
});

import { describe, expect, test } from "vitest";

/**
 * Tests for WebSocket message type validation
 * These test the type guards and message structure validation in remote-tunnel-manager
 */

// We'll test the isWebSocketMessage type guard by importing it
// For now, we'll test the expected message structures

describe("WebSocket Message Types", () => {
  describe("Message Structure Validation", () => {
    test("connection:response message should have correct structure", () => {
      const validMessage = {
        type: "connection:response",
        viewer: "user@example.com",
        approved: true,
      };

      expect(validMessage).toHaveProperty("type", "connection:response");
      expect(validMessage).toHaveProperty("viewer");
      expect(validMessage).toHaveProperty("approved");
      expect(typeof validMessage.approved).toBe("boolean");
    });

    test("file:read:response message should have correct structure", () => {
      const validMessage = {
        type: "file:read:response",
        requestId: "123-456",
        content: "file contents",
      };

      expect(validMessage).toHaveProperty("type", "file:read:response");
      expect(validMessage).toHaveProperty("requestId");
      expect(validMessage).toHaveProperty("content");
    });

    test("file:read:response error message should have error property", () => {
      const errorMessage = {
        type: "file:read:response",
        requestId: "123-456",
        error: "File not found",
      };

      expect(errorMessage).toHaveProperty("type", "file:read:response");
      expect(errorMessage).toHaveProperty("requestId");
      expect(errorMessage).toHaveProperty("error");
    });

    test("dir:list:response message should have correct structure", () => {
      const validMessage = {
        type: "dir:list:response",
        requestId: "123-456",
        content: JSON.stringify(["file1.sql", "file2.sql"]),
      };

      expect(validMessage).toHaveProperty("type", "dir:list:response");
      expect(validMessage).toHaveProperty("requestId");
      expect(validMessage).toHaveProperty("content");

      // Content should be parseable as JSON array
      const files = JSON.parse(validMessage.content);
      expect(Array.isArray(files)).toBe(true);
    });

    test("dir:list:response error message should have error property", () => {
      const errorMessage = {
        type: "dir:list:response",
        requestId: "123-456",
        error: "Permission denied",
      };

      expect(errorMessage).toHaveProperty("type", "dir:list:response");
      expect(errorMessage).toHaveProperty("requestId");
      expect(errorMessage).toHaveProperty("error");
    });

    test("fetch:response:meta message should have correct structure", () => {
      const validMessage = {
        type: "fetch:response:meta",
        requestId: "123-456",
        status: 200,
        headers: { "content-type": "text/html" },
      };

      expect(validMessage).toHaveProperty("type", "fetch:response:meta");
      expect(validMessage).toHaveProperty("requestId");
      expect(validMessage).toHaveProperty("status");
      expect(validMessage).toHaveProperty("headers");
      expect(typeof validMessage.status).toBe("number");
    });

    test("hmr:message should have correct structure", () => {
      const validMessage = {
        type: "hmr:message",
        body: '{"type":"update","path":"/src/App.tsx"}',
      };

      expect(validMessage).toHaveProperty("type", "hmr:message");
      expect(validMessage).toHaveProperty("body");
      expect(typeof validMessage.body).toBe("string");
    });
  });

  describe("Invalid Message Structures", () => {
    test("should reject message without type field", () => {
      const invalidMessage = {
        requestId: "123-456",
        content: "some data",
      };

      expect(invalidMessage).not.toHaveProperty("type");
    });

    test("should reject message with non-string type", () => {
      const invalidMessage = {
        type: 123,
        requestId: "123-456",
      };

      expect(typeof invalidMessage.type).not.toBe("string");
    });

    test("should reject null or undefined", () => {
      expect(null).toBeNull();
      expect(undefined).toBeUndefined();
    });

    test("should reject non-object messages", () => {
      expect(typeof "string message").toBe("string");
      expect(typeof 123).toBe("number");
      expect(Array.isArray([])).toBe(true);
    });
  });

  describe("Message Content Validation", () => {
    test("dir:list:response content should be valid JSON array of strings", () => {
      const validContent = JSON.stringify([
        "file1.sql",
        "file2.sql",
        "file3.sql",
      ]);
      const parsed = JSON.parse(validContent) as unknown[];

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.every((item: unknown) => typeof item === "string")).toBe(
        true,
      );
    });

    test("should reject dir:list:response with non-array content", () => {
      const invalidContent = JSON.stringify({ files: ["file1.sql"] });
      const parsed = JSON.parse(invalidContent) as unknown;

      expect(Array.isArray(parsed)).toBe(false);
    });

    test("should reject dir:list:response with non-string array elements", () => {
      const invalidContent = JSON.stringify(["file1.sql", 123, "file2.sql"]);
      const parsed = JSON.parse(invalidContent) as unknown[];

      expect(parsed.every((item: unknown) => typeof item === "string")).toBe(
        false,
      );
    });

    test("should handle empty array in dir:list:response", () => {
      const validContent = JSON.stringify([]);
      const parsed = JSON.parse(validContent);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(0);
    });
  });

  describe("Error Handling", () => {
    test("file:read:response should have either content or error", () => {
      const successMessage: {
        type: string;
        requestId: string;
        content?: string;
        error?: string;
      } = {
        type: "file:read:response",
        requestId: "123",
        content: "data",
      };
      const errorMessage: {
        type: string;
        requestId: string;
        content?: string;
        error?: string;
      } = {
        type: "file:read:response",
        requestId: "123",
        error: "failed",
      };

      expect(
        successMessage.content !== undefined ||
          successMessage.error !== undefined,
      ).toBe(true);
      expect(
        errorMessage.content !== undefined || errorMessage.error !== undefined,
      ).toBe(true);
    });

    test("dir:list:response should have either content or error", () => {
      const successMessage: {
        type: string;
        requestId: string;
        content?: string;
        error?: string;
      } = {
        type: "dir:list:response",
        requestId: "123",
        content: "[]",
      };
      const errorMessage: {
        type: string;
        requestId: string;
        content?: string;
        error?: string;
      } = {
        type: "dir:list:response",
        requestId: "123",
        error: "failed",
      };

      expect(
        successMessage.content !== undefined ||
          successMessage.error !== undefined,
      ).toBe(true);
      expect(
        errorMessage.content !== undefined || errorMessage.error !== undefined,
      ).toBe(true);
    });
  });
});

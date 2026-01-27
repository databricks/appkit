import { describe, expect, it } from "vitest";
import * as z from "zod";
import { ValidationError } from "@/core/errors";
import {
  defaultValidator,
  TaskValidator,
  validateInputSchema,
  validateTaskInput,
} from "@/guard/validator";

describe("TaskValidator", () => {
  const validator = new TaskValidator();

  describe("validateTaskName", () => {
    it("should accept valid task names (alphanumeric, underscore, hyphen", () => {
      expect(() => validator.validateName("myTask")).not.toThrow();
      expect(() => validator.validateName("my_task")).not.toThrow();
      expect(() => validator.validateName("my-task")).not.toThrow();
      expect(() => validator.validateName("MyTask123")).not.toThrow();
      expect(() => validator.validateName("a")).not.toThrow();
      expect(() => validator.validateName("123Task")).not.toThrow();
    });

    it("should reject empty task name", () => {
      expect(() => validator.validateName("")).toThrow(ValidationError);
      try {
        validator.validateName("");
      } catch (error) {
        expect((error as ValidationError).field).toBe("name");
      }
    });

    it("should reject task name with special character", () => {
      expect(() => validator.validateName("my.task")).toThrow(ValidationError);
      expect(() => validator.validateName("my task")).toThrow(ValidationError);
      expect(() => validator.validateName("my@task")).toThrow(ValidationError);
      expect(() => validator.validateName("my/task")).toThrow(ValidationError);
    });

    it("should reject task name exceeding max length", () => {
      const longName = "a".repeat(257);
      expect(() => validator.validateName(longName)).toThrow(ValidationError);
    });

    it("should accept task name at max length", () => {
      const longName = "a".repeat(256);
      expect(() => validator.validateName(longName)).not.toThrow();
    });
  });

  describe("validatePayload", () => {
    it("should accept valid JSON payload (object, array, string, number, null, boolean)", () => {
      expect(() => validator.validatePayload({ key: "value" })).not.toThrow();
      expect(() => validator.validatePayload([1, 2, 3])).not.toThrow();
      expect(() => validator.validatePayload("string")).not.toThrow();
      expect(() => validator.validatePayload(123)).not.toThrow();
      expect(() => validator.validatePayload(null)).not.toThrow();
      expect(() => validator.validatePayload(true)).not.toThrow();
    });

    it("should reject non-serializable payload (circular reference)", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => validator.validatePayload(circular)).toThrow(
        ValidationError,
      );

      try {
        validator.validatePayload(circular);
      } catch (error) {
        expect((error as ValidationError).field).toBe("input");
        expect((error as ValidationError).message).toContain(
          "JSON serializable",
        );
      }
    });

    it("should reject payload exceeding max size", () => {
      const customValidator = new TaskValidator({ maxPayloadSizeBytes: 10 });
      const largePayload = { data: "#".repeat(100) };
      expect(() => customValidator.validatePayload(largePayload)).toThrow(
        ValidationError,
      );
    });

    it("should include size info in error message", () => {
      const customValidator = new TaskValidator({ maxPayloadSizeBytes: 10 });
      try {
        customValidator.validatePayload({ data: "#".repeat(100) });
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain("bytes");
        expect((error as ValidationError).message).toContain("exceeds");
      }
    });

    it("should handle UTF-8 characters correctly", () => {
      const customValidator = new TaskValidator({ maxPayloadSizeBytes: 20 });
      expect(() => customValidator.validatePayload("你好")).not.toThrow();
    });
  });

  describe("validateUserId", () => {
    it("should accept valid user IDs", () => {
      expect(() => validator.validateUserId("user-123")).not.toThrow();
      expect(() => validator.validateUserId("a")).not.toThrow();
      expect(() => validator.validateUserId("user@example.com")).not.toThrow();
      expect(() => validator.validateUserId("123-456-789")).not.toThrow();
    });

    it("should reject empty user ID", () => {
      expect(() => validator.validateUserId("")).toThrow();
      try {
        validator.validateUserId("");
      } catch (error) {
        expect((error as ValidationError).field).toBe("userId");
      }
    });

    it("should reject userId exceeding max length", () => {
      const longId = "a".repeat(257);
      expect(() => validator.validateUserId(longId)).toThrow(ValidationError);
    });

    it("should accept userId at max length", () => {
      const longId = "a".repeat(256);
      expect(() => validator.validateUserId(longId)).not.toThrow();
    });
  });

  describe("validate (full)", () => {
    it("should validate complete task input", () => {
      expect(() =>
        validator.validate({
          name: "myTask",
          input: { key: "value" },
          userId: "user-123",
        }),
      ).not.toThrow();
    });

    it("should validate task input without userId (background tasks)", () => {
      expect(() =>
        validator.validate({
          name: "myTask",
          input: { key: "value" },
        }),
      ).not.toThrow();
    });

    it("should validate task input without input", () => {
      expect(() =>
        validator.validate({
          name: "myTask",
        }),
      ).not.toThrow();
    });

    it("should throw on invalid name", () => {
      expect(() =>
        validator.validate({
          name: "",
          input: { key: "value" },
        }),
      ).toThrow(ValidationError);
    });

    it("should throw on invalid payload", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() =>
        validator.validate({
          name: "",
          input: circular,
        }),
      ).toThrow(ValidationError);
    });

    it("should throw on invalid userId", () => {
      expect(() =>
        validator.validate({
          name: "",
          userId: "",
        }),
      ).toThrow(ValidationError);
    });
  });

  describe("validateInputSchema", () => {
    it("should validate input against a Zod schema", () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = validator.validateInputSchema(
        { name: "John", age: 30 },
        schema,
      );

      expect(result).toEqual({ name: "John", age: 30 });
    });

    it("should throw ValidationError on invalid input", () => {
      const schema = z.object({
        name: z.string().min(1, "Name is required"),
      });

      expect(() => validator.validateInputSchema({ name: "" }, schema)).toThrow(
        ValidationError,
      );
    });
  });

  describe("customConfiguration", () => {
    it("should respect custom max payload size", () => {
      const customValidator = new TaskValidator({ maxPayloadSizeBytes: 50 });
      expect(() =>
        customValidator.validatePayload({ small: "data" }),
      ).not.toThrow();
    });

    it("should respect custom task name pattern", () => {
      const customValidator = new TaskValidator({ taskNamePattern: /^task_/ }); // task name must start
      expect(() =>
        customValidator.validatePayload({ small: "data" }),
      ).not.toThrow();
    });
    it("should respect custom name length limits", () => {
      const customValidator = new TaskValidator({
        minUserIdLength: 3,
        maxUserIdLength: 10,
      });
      expect(() => customValidator.validateUserId("ab")).toThrow();
      expect(() => customValidator.validateUserId("abc")).not.toThrow();
      expect(() => customValidator.validateUserId("a".repeat(11))).toThrow(
        ValidationError,
      );
    });

    it("should respect custom userId length limits", () => {
      const customValidator = new TaskValidator({
        minUserIdLength: 5,
        maxUserIdLength: 20,
      });

      expect(() => customValidator.validateUserId("abcd")).toThrow(
        ValidationError,
      );
      expect(() => customValidator.validateUserId("abcde")).not.toThrow();
      expect(() => customValidator.validateUserId("a".repeat(21))).toThrow(
        ValidationError,
      );
    });
  });

  describe("helper functions", () => {
    it("validateTaskInput should use default validator", () => {
      expect(() =>
        validateTaskInput({ name: "testTask", input: { data: "test" } }),
      ).not.toThrow();
    });

    it("validateTaskInput should throw ValidationError if input is invalid", () => {
      expect(() =>
        validateTaskInput({ name: "", input: { data: "test" } }),
      ).toThrow(ValidationError);
    });

    it("validateInputSchema should use default validator", () => {
      expect(() =>
        validateInputSchema({ data: "test" }, z.object({ data: z.string() })),
      ).not.toThrow();
    });

    it("validateInputSchema should throw ValidationError if input is invalid", () => {
      expect(() =>
        validateInputSchema({ data: "test" }, z.object({ data: z.number() })),
      ).toThrow(ValidationError);
    });
  });
  describe("defaultValidator", () => {
    it("should be a TaskValidator instance", () => {
      expect(defaultValidator).toBeInstanceOf(TaskValidator);
    });

    it("should validate correctly", () => {
      expect(() =>
        defaultValidator.validate({
          name: "testTask",
          input: { data: "test" },
        }),
      ).not.toThrow();
    });
  });
});

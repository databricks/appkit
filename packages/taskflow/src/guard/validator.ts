import type { ZodType } from "zod";
/**
 * Task validator
 * Validates task inputs before admission into the task system
 */

import { ValidationError } from "@/core/errors";

/**
 * Configuration for the task validator
 */
export interface ValidatorConfig {
  /** Maximum payload size in bytes */
  maxPayloadSizeBytes: number;
  /** Maximum task name length */
  maxTaskNameLength: number;
  /** Minimum task name length */
  minTaskNameLength: number;
  /** Pattern for valid task names */
  taskNamePattern: RegExp;
  /** Maximum user ID length */
  maxUserIdLength: number;
  /** Minimum user ID length */
  minUserIdLength: number;
}

/**
 * Default validator configuration
 */
const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  maxPayloadSizeBytes: 1024 * 1024, // 1MB
  maxTaskNameLength: 256,
  minTaskNameLength: 1,
  taskNamePattern: /^[a-zA-Z0-9_-]+$/,
  maxUserIdLength: 256,
  minUserIdLength: 1,
};

/**
 * Input structure for task validation
 */
export interface TaskInput {
  /** Task name/template */
  name: string;
  /** Task input payload */
  input?: unknown;
  /** Optional user ID */
  userId?: string;
}

/**
 * Task validator for validating task inputs before admission
 * @example
 * const validator = new TaskValidator();
 *
 * // validate a full task input
 * validator.validate({ name: "my-task", input: { data: 123 }, userId: "user-1"});
 *
 * // validate against a Zod schema
 * const schema = z.object({ data: z.number() });
 * const parsed = validator.validateInputSchema({ data: 123 }, schema);
 */
export class TaskValidator {
  private readonly config: ValidatorConfig;

  constructor(config: Partial<ValidatorConfig> = {}) {
    this.config = { ...DEFAULT_VALIDATOR_CONFIG, ...config };
  }

  /**
   * Validates a complete task input
   * @throws {ValidationError} if any validation fails
   */
  validate(taskInput: TaskInput): void {
    this.validateName(taskInput.name);
    if (taskInput.input) this.validatePayload(taskInput.input);
    if (taskInput.userId) this.validateUserId(taskInput.userId);
  }

  /**
   * Validates a task name
   * @throws {ValidationError} if the name is invalid
   */
  validateName(name: string): void {
    if (typeof name !== "string")
      throw new ValidationError("Task name must be a string", "name");

    if (name.length < this.config.minTaskNameLength)
      throw new ValidationError(
        `Task name must be at least ${this.config.minTaskNameLength} character(s) `,
        "name",
      );

    if (name.length > this.config.maxTaskNameLength)
      throw new ValidationError(
        `Task name must not exceed ${this.config.maxTaskNameLength} character `,
        "name",
      );

    if (!this.config.taskNamePattern.test(name)) {
      throw new ValidationError(
        "Task name must contain only alphanumeric characters, underscores, or hyphens",
        "name",
      );
    }
  }

  /**
   * Validates a task payload
   * @throws {ValidationError} if the payload is invalid or too large
   */
  validatePayload(input: unknown): void {
    const size = this.calculatePayloadSize(input);
    if (size > this.config.maxPayloadSizeBytes) {
      throw new ValidationError(
        `Payload size (${size}) exceeds maximum allowed (${this.config.maxPayloadSizeBytes} bytes)`,
        "input",
      );
    }
  }

  /**
   * Validates a user ID
   * @throws {ValidationError} if the user ID is invalid
   */
  validateUserId(userId: string): void {
    if (typeof userId !== "string") {
      throw new ValidationError("User ID must be a string", "userId");
    }

    if (userId.length < this.config.minUserIdLength) {
      throw new ValidationError(
        `User ID must be at least ${this.config.minUserIdLength} character(s)`,
        "userId",
      );
    }

    if (userId.length > this.config.maxUserIdLength) {
      throw new ValidationError(
        `User ID must not exceed ${this.config.maxUserIdLength} characters`,
        "userId",
      );
    }
  }

  /**
   * Validates input against a Zod schema
   * @returns The parsed and transformed data
   * @throws {ValidationError} if validation fails
   */
  validateInputSchema<T>(input: unknown, schema: ZodType<T>): T {
    const result = schema.safeParse(input);
    if (!result.success) {
      const zodError = result.error;
      const firstIssue = zodError.issues[0];
      const path = firstIssue.path.join(".") || "input";
      const message = firstIssue.message || "Invalid input";
      throw new ValidationError(`Input validation failed ${message}`, path, {
        zodError: zodError.format(),
      });
    }
    return result.data;
  }

  /**
   * Calculate the byte size of a payload
   * @throws {ValidationError} if the payload is not JSON serializable
   */
  private calculatePayloadSize(input: unknown): number {
    try {
      const json = JSON.stringify(input);
      return new TextEncoder().encode(json).length;
    } catch {
      throw new ValidationError("Payload must be a JSON serializable", "input");
    }
  }
}

/**
 * Default validator instance with standard configuration
 */
export const defaultValidator = new TaskValidator();

/** Convenience function to validate task input string using the default validator */
export function validateTaskInput(taskInput: TaskInput): void {
  defaultValidator.validate(taskInput);
}

/**
 * Convenience function to validate input against a Zod schema
 * @param input - The input to validate
 * @param schema - The Zod schema to validate against
 */
export function validateInputSchema<T>(input: unknown, schema: ZodType<T>): T {
  return defaultValidator.validateInputSchema(input, schema);
}

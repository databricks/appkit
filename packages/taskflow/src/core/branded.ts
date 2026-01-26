import { z } from "zod";

/**
 * Branded types for Type-Safe IDs
 *
 * Branded types prevent accidentally mixing up different types of IDs
 * at compile time, while remaining plain strings at runtime.
 */

/**
 * Creates a branded type - a string that carries a type-level tag.
 */
declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

/**
 * Task ID = unique identifier for a task.
 */
export type TaskId = Brand<string, "TaskId">;

/**
 * Task Name = registered task handler name.
 */
export type TaskName = Brand<string, "TaskName">;

/**
 * Idempotency key = used for task deduplication.
 */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

/**
 * User ID = identifies the user who created the task.
 */
export type UserId = Brand<string, "UserId">;

/**
 * Event ID = unique identifier for a task event.
 */
export type EventId = Brand<string, "EventId">;

/**
 * Creates a TaskName from a string
 */
export function taskName(value: string): TaskName {
  return value as TaskName;
}

/**
 * Creates a TaskId from a string
 */
export function taskId(value: string): TaskId {
  return value as TaskId;
}

/**
 * Creates an IdempotencyKey from a string
 */
export function idempotencyKey(value: string): IdempotencyKey {
  return value as IdempotencyKey;
}

/**
 * Creates a UserId from a string
 */
export function userId(value: string | null): UserId | null {
  return value as UserId | null;
}

/**
 * Creates an EventId from a string
 */
export function eventId(value: string): EventId {
  return value as EventId;
}

/**
 * Checks if a value is a non-empty string (basic validation)
 */
export function isValidId(value: string): value is Brand<string, string> {
  return typeof value === "string" && value.trim() !== "";
}

export const TaskNameSchema = z
  .string()
  .min(1)
  .max(256)
  .transform((value) => value as TaskName);

export const TaskIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as TaskId);

export const IdempotencyKeySchema = z
  .string()
  .length(64)
  .transform((value) => value as IdempotencyKey);

export const UserIdSchema = z
  .string()
  .min(1)
  .max(256)
  .transform((value) => value as UserId);

export const EventIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as EventId);

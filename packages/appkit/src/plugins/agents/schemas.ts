import { z } from "zod";

/**
 * Static body cap for the `message` field on `POST /chat`. 64 000 characters
 * is well above any legitimate chat turn (~16k tokens at 4 chars/token) and
 * bounds the per-request cost of appending to `InMemoryThreadStore` without
 * requiring per-deployment configuration.
 */
const MAX_MESSAGE_CHARS = 64_000;

/** Cap applied to `/invocations` when `input` is a raw string. */
const MAX_INVOCATIONS_INPUT_CHARS = 64_000;

/**
 * Cap on the number of items accepted in an `/invocations` `input` array
 * (one element per seeded message). Protects against a single request
 * seeding hundreds of messages into the thread store.
 */
const MAX_INVOCATIONS_INPUT_ITEMS = 100;

/** Per-message `content` size cap (string form). */
const MAX_INVOCATIONS_ITEM_CHARS = 64_000;

/** Per-message `content` size cap (array form). */
const MAX_INVOCATIONS_ITEM_ARRAY_ITEMS = 100;

export const chatRequestSchema = z.object({
  message: z
    .string()
    .min(1, "message must not be empty")
    .max(
      MAX_MESSAGE_CHARS,
      `message exceeds the ${MAX_MESSAGE_CHARS}-character limit`,
    ),
  threadId: z.string().optional(),
  agent: z.string().optional(),
});

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant", "system"]).optional(),
  content: z
    .union([
      z.string().max(MAX_INVOCATIONS_ITEM_CHARS),
      z.array(z.any()).max(MAX_INVOCATIONS_ITEM_ARRAY_ITEMS),
    ])
    .optional(),
  type: z.string().optional(),
});

export const invocationsRequestSchema = z.object({
  input: z.union([
    z.string().min(1).max(MAX_INVOCATIONS_INPUT_CHARS),
    z
      .array(messageItemSchema)
      .min(1)
      .max(
        MAX_INVOCATIONS_INPUT_ITEMS,
        `input array exceeds the ${MAX_INVOCATIONS_INPUT_ITEMS}-item limit`,
      ),
  ]),
  model: z.string().optional(),
});

export const approvalRequestSchema = z.object({
  streamId: z.string().min(1, "streamId is required"),
  approvalId: z.string().min(1, "approvalId is required"),
  decision: z.enum(["approve", "deny"]),
});

export const cancelRequestSchema = z.object({
  streamId: z.string().min(1, "streamId is required"),
});

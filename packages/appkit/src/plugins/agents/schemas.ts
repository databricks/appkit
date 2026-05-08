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

/**
 * Maximum number of UI tools a client may register per chat request. A real
 * AppKit page registers maybe a dozen capability tools; capping at 64 keeps
 * the per-request payload bounded against accidental or malicious bloat.
 */
const MAX_UI_TOOLS = 64;

/**
 * Per-tool description cap. Mirrors the order of magnitude of `description`
 * fields on shipped plugin tools — long enough to be useful to the LLM,
 * short enough that 64 of them fit comfortably in a single chat request.
 */
const MAX_UI_TOOL_DESCRIPTION_CHARS = 1_000;

const toolEffectSchema = z.enum(["read", "write", "update", "destructive"]);

const toolAnnotationsSchema = z
  .object({
    effect: toolEffectSchema.optional(),
    readOnly: z.boolean().optional(),
    destructive: z.boolean().optional(),
    idempotent: z.boolean().optional(),
    requiresUserContext: z.boolean().optional(),
  })
  .strict();

/**
 * Per-message UI-tool catalog entry. Mirrors `AgentToolDefinition` but with
 * size caps applied: a misbehaving (or compromised) client cannot grow the
 * agent's tool list arbitrarily. `parameters` is accepted as an opaque object
 * so we don't reject a valid JSON Schema the server-side type system would
 * otherwise narrow incorrectly.
 */
const uiToolDefinitionSchema = z
  .object({
    name: z.string().min(1, "tool name must not be empty").max(120),
    description: z.string().max(MAX_UI_TOOL_DESCRIPTION_CHARS),
    parameters: z.record(z.string(), z.unknown()),
    annotations: toolAnnotationsSchema.optional(),
  })
  .strict();

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
  /**
   * UI tools registered by the calling browser for the lifetime of this
   * single chat request. Names must be unique within the catalog and are
   * additionally checked against the agent's static tool index server-side
   * (collisions are rejected to prevent a UI tool from shadowing a plugin
   * tool the LLM thought it was calling).
   */
  uiTools: z
    .array(uiToolDefinitionSchema)
    .max(MAX_UI_TOOLS, `uiTools exceeds the ${MAX_UI_TOOLS}-entry limit`)
    .optional(),
});

export const clientToolResultSchema = z
  .object({
    streamId: z.string().min(1, "streamId is required"),
    callId: z.string().min(1, "callId is required"),
    result: z.unknown().optional(),
    error: z.string().max(8_000).optional(),
  })
  .refine(
    (v) => v.result !== undefined || typeof v.error === "string",
    "client-tool-result must include either `result` or `error`",
  );

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

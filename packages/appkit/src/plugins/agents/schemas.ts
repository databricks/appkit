import { z } from "zod";

export const chatRequestSchema = z.object({
  message: z.string().min(1, "message must not be empty"),
  threadId: z.string().optional(),
  agent: z.string().optional(),
});

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant", "system"]).optional(),
  content: z.union([z.string(), z.array(z.any())]).optional(),
  type: z.string().optional(),
});

export const invocationsRequestSchema = z.object({
  input: z.union([z.string().min(1), z.array(messageItemSchema).min(1)]),
  stream: z.boolean().optional().default(true),
  model: z.string().optional(),
});

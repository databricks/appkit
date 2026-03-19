import type { StdioRequestPayload, StdioResponsePayload } from "shared";
import { z } from "zod";

export const stdioRequestSchema = z.object({
  path: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  body: z.unknown().optional(),
});

// Compile-time check: Zod-inferred type must be assignable to the shared type
const _requestCheck: StdioRequestPayload = {} as z.infer<
  typeof stdioRequestSchema
>;

const stdioResponseSchema = z.object({
  status: z.number().int().min(100).max(599).default(200),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

const _responseCheck: StdioResponsePayload = {} as z.infer<
  typeof stdioResponseSchema
>;

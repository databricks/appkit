import type express from "express";
import { VERCEL_AI_UI_MESSAGE_STREAM_MIME } from "shared";

type ChatProtocol = "responses-api" | "vercel-ai-ui-message-stream";

/**
 * Pick the wire protocol for a chat request. Inspects `Accept` first;
 * falls back to a custom `x-appkit-protocol` header so callers without
 * fine-grained Accept control (e.g. some embedded clients) can opt in.
 */
export function detectChatProtocol(req: express.Request): ChatProtocol {
  const accept = (req.headers.accept ?? "").toLowerCase();
  if (accept.includes(VERCEL_AI_UI_MESSAGE_STREAM_MIME)) {
    return "vercel-ai-ui-message-stream";
  }
  const explicit = req.headers["x-appkit-protocol"];
  if (
    typeof explicit === "string" &&
    explicit.trim() === "vercel-ai-ui-message-stream"
  ) {
    return "vercel-ai-ui-message-stream";
  }
  return "responses-api";
}

/**
 * Extract user text from a Vercel AI SDK `UIMessage.parts` array. The SDK
 * supports many part types (text, file, reasoning, tool-* …); for the
 * purposes of seeding the agent's user turn we only care about text
 * parts. File and tool-call parts in the inbound message are ignored
 * because the agent loop runs server-side and does not need the client's
 * locally-rendered tool history.
 */
export function extractVercelAIUserText(parts: unknown[]): string {
  let text = "";
  for (const part of parts) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      text += (part as { text: string }).text;
    }
  }
  return text;
}

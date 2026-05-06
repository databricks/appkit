import type { UIMessage } from "ai";

/**
 * Custom data parts emitted by AppKit's Vercel AI SDK UI Message Stream
 * branch (server: `VercelAIUIMessageStreamTranslator`).
 *
 * AppKit-only payloads — these only exist because of the Vercel AI SDK
 * `useChat` integration and are not part of the SDK protocol itself.
 */
export interface VercelAIAgentDataParts {
  /**
   * A destructive tool call is paused on the server-side approval gate.
   * The client renders an approval card and POSTs the user's decision to
   * `/api/agents/approve`. The approval gate auto-denies on timeout.
   */
  "approval-pending": {
    approvalId: string;
    streamId: string;
    toolName: string;
    args: unknown;
    annotations?: {
      effect?: "read" | "write" | "update" | "destructive";
      readOnly?: boolean;
      destructive?: boolean;
      idempotent?: boolean;
    };
  };
}

/**
 * Strongly-typed UIMessage for the AppKit agent chat. Used as the type
 * parameter to `useChat<VercelAIAgentUIMessage>()` so message metadata,
 * data-part dispatch, and `onData` callbacks are all type-checked.
 */
export type VercelAIAgentUIMessage = UIMessage<unknown, VercelAIAgentDataParts>;

/**
 * MIME type advertised on the `Accept` header to opt the agents plugin's
 * `POST /chat` route into the Vercel AI SDK UI Message Stream protocol.
 * Mirrored on the server as `VERCEL_AI_UI_MESSAGE_STREAM_MIME` (in
 * `shared/chat-protocol`). Duplicated here because the dev-playground
 * client is npm-managed and cannot pull workspace-only deps.
 */
export const VERCEL_AI_UI_MESSAGE_STREAM_ACCEPT =
  "application/vnd.ai-sdk.ui-message-stream";

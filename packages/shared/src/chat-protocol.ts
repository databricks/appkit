/**
 * Vendor MIME type advertised by the Vercel AI SDK chat client so the
 * server selects the UI Message Stream wire protocol. Shared between the
 * agents plugin server and any client that wants to opt into the
 * protocol via an `Accept` header.
 */
export const VERCEL_AI_UI_MESSAGE_STREAM_MIME =
  "application/vnd.ai-sdk.ui-message-stream";

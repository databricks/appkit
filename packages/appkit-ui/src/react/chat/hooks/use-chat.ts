import { type UseChatHelpers, useChat as useAiChat } from "@ai-sdk/react";
import type {
  ChatOnDataCallback,
  ChatOnFinishCallback,
  HttpChatTransportInitOptions,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import { ResponsesApiTransport } from "../lib/responses-api-transport";
import { generateId } from "../lib/utils";

export interface UseChatOptions<TMessage extends UIMessage = UIMessage> {
  /** Chat endpoint URL (e.g. "/api/agents/chat"). */
  api: string;
  /** Stable chat id. Defaults to a fresh UUID per mount. */
  id?: string;
  /**
   * Initial thread id for resuming an existing conversation. Captured into
   * an internal ref at mount; to switch to a different thread, remount the
   * hook (e.g. via a `key` prop on the consumer component) together with a
   * fresh `messages` seed.
   */
  threadId?: string;
  /** Initial messages (e.g. when hydrating from history). */
  messages?: TMessage[];
  /** Extra fetch headers forwarded to the transport. */
  headers?: HttpChatTransportInitOptions<TMessage>["headers"];
  /** Fires for every `data-*` chunk (e.g. `data-approval-pending`). */
  onData?: ChatOnDataCallback<TMessage>;
  /** Fires synchronously for every chunk. Unaffected by render throttling. */
  onStreamPart?: (chunk: UIMessageChunk) => void;
  /** Called on stream errors. */
  onError?: (error: Error) => void;
  /**
   * Called once per completed turn (success, abort, disconnect, or error).
   * Useful for side effects that should run when the stream settles, e.g.
   * refreshing a thread-history list.
   */
  onFinish?: ChatOnFinishCallback<TMessage>;
}

export type UseChatReturn<TMessage extends UIMessage = UIMessage> =
  UseChatHelpers<TMessage> & { id: string };

export function useChat<TMessage extends UIMessage = UIMessage>(
  options: UseChatOptions<TMessage>,
): UseChatReturn<TMessage> {
  const { api, id: providedId, messages, onData, onError } = options;

  const [id] = useState(() => providedId ?? generateId());
  const initialMessagesRef = useRef<TMessage[]>(messages ?? []);

  // Ref'd so the transport memo stays stable when consumers pass inline
  // objects/callbacks. The transport reads them lazily on each request.
  const onStreamPartRef = useRef(options.onStreamPart);
  onStreamPartRef.current = options.onStreamPart;
  const headersRef = useRef(options.headers);
  headersRef.current = options.headers;
  // Same treatment for onFinish — consumers commonly chain it with
  // other state (`useCallback(..., [threadList])`) and we don't want
  // that to depend on whatever the AI SDK does with the callback
  // identity. A stable wrapper that dereferences the ref each turn
  // gives us "always run the latest" semantics without churning the
  // transport or any other memo that touches `chat`.
  const onFinishRef = useRef(options.onFinish);
  onFinishRef.current = options.onFinish;
  const onFinish = useCallback<ChatOnFinishCallback<TMessage>>((args) => {
    onFinishRef.current?.(args);
  }, []);

  const threadIdRef = useRef<string | undefined>(options.threadId);

  const transport = useMemo(
    () =>
      new ResponsesApiTransport<TMessage>({
        api,
        // Resolve the live ref each request so the transport memo stays
        // stable even when consumers pass inline header objects/functions.
        headers: async () => {
          const h = headersRef.current;
          if (typeof h === "function") return await h();
          return h ?? {};
        },
        getThreadId: () => threadIdRef.current,
        onThreadId: (tid) => {
          threadIdRef.current = tid;
        },
        onStreamPart: (part) => onStreamPartRef.current?.(part),
      }),
    [api],
  );

  const chat = useAiChat<TMessage>({
    id,
    messages: initialMessagesRef.current,
    experimental_throttle: 100,
    generateId,
    transport,
    onData,
    onError,
    onFinish,
  });

  return { ...chat, id };
}

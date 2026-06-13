import { type UseChatHelpers, useChat as useAiChat } from "@ai-sdk/react";
import type {
  ChatOnDataCallback,
  HttpChatTransportInitOptions,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { useMemo, useRef, useState } from "react";
import { ResponsesApiTransport } from "../lib/responses-api-transport";
import { generateId } from "../lib/utils";

export interface UseChatOptions<TMessage extends UIMessage = UIMessage> {
  /** Chat endpoint URL (e.g. "/api/agents/chat"). */
  api: string;
  /** Stable chat id. Defaults to a fresh UUID per mount. */
  id?: string;
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

  const threadIdRef = useRef<string | undefined>(undefined);

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
  });

  return { ...chat, id };
}

import { type UseChatHelpers, useChat as useAiChat } from "@ai-sdk/react";
import type {
  ChatOnDataCallback,
  HttpChatTransportInitOptions,
  LanguageModelUsage,
  PrepareSendMessagesRequest,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { useChatContext } from "../context";
import { ChatError } from "../errors";
import { isCredentialErrorMessage } from "../lib/oauth";
import { ChatTransport } from "../lib/transport";
import { apiUrl, fetchWithErrorHandlers, generateUUID } from "../lib/utils";
import type {
  ChatFeedbackMap,
  ChatMessage,
  ChatVisibilityType,
} from "../types";
import { getChatHistoryPaginationKey } from "./use-history";

export type UseChatReturn<TMessage extends UIMessage = ChatMessage> =
  UseChatHelpers<TMessage> & {
    id: string;
    title: string | undefined;
    isTitleLoading: boolean;
    isReadonly: boolean;
    feedback: ChatFeedbackMap;
    visibilityType: ChatVisibilityType;
    model: string;
  };

export interface UseChatOptions<TMessage extends UIMessage = ChatMessage> {
  id?: string;
  initialMessages?: TMessage[];
  model?: string;
  initialVisibility?: ChatVisibilityType;
  isReadonly?: boolean;
  feedback?: ChatFeedbackMap;
  title?: string;
  onError?: (error: Error) => void;
  onTitleGenerated?: (title: string) => void;

  /**
   * Override the chat endpoint URL. Defaults to `apiUrl(apiBase, "/")`
   * (i.e. derived from the surrounding `ChatProvider`'s `apiBase`).
   */
  api?: string;
  /**
   * Extra fetch headers (e.g. `Accept` for content negotiation). Forwarded
   * verbatim to the underlying transport.
   */
  headers?: HttpChatTransportInitOptions<TMessage>["headers"];
  /**
   * Replaces the default body builder. When provided, the default
   * `{ id, messages, trigger }` shape is NOT emitted — the consumer is
   * fully responsible for the request body.
   */
  prepareSendMessagesRequest?: PrepareSendMessagesRequest<TMessage>;
  /**
   * Called AFTER the hook's internal `data-usage` / `data-title` handlers
   * for every received data part. Use this to react to custom data parts
   * (e.g. tool-approval prompts) without forking the hook.
   */
  onData?: ChatOnDataCallback<TMessage>;
  /**
   * Called for every raw `UIMessageChunk` arriving from the transport
   * (text-delta, reasoning-delta, tool-input-available, finish, etc.).
   * Fires synchronously inside the stream pipeline — unaffected by render
   * throttling — so it's the right hook for chronological event logging
   * or debug panels.
   */
  onStreamPart?: (part: UIMessageChunk) => void;
}

export function useChat<TMessage extends UIMessage = ChatMessage>(
  options: UseChatOptions<TMessage> = {},
): UseChatReturn<TMessage> {
  const {
    id: providedId,
    initialMessages,
    model = "chat-model",
    initialVisibility = "private",
    isReadonly = false,
    feedback = {},
    title: externalTitle,
    onError: onErrorCb,
    onTitleGenerated,
    api: apiOverride,
    headers,
    prepareSendMessagesRequest: prepareSendMessagesRequestOverride,
    onData: onDataOverride,
    onStreamPart: onStreamPartOverride,
  } = options;

  const [id] = useState(() => providedId ?? generateUUID());
  const initialMessagesRef = useRef<TMessage[]>(initialMessages ?? []);
  const { chatHistoryEnabled, apiBase, onNavigate } = useChatContext();

  const [visibilityType] = useState<ChatVisibilityType>(initialVisibility);

  const { mutate } = useSWRConfig();

  const [_usage, setUsage] = useState<LanguageModelUsage | undefined>();
  const [lastPart, setLastPart] = useState<UIMessageChunk | undefined>();
  const lastPartRef = useRef<UIMessageChunk | undefined>(lastPart);
  lastPartRef.current = lastPart;

  const resumeAttemptCountRef = useRef(0);
  const maxResumeAttempts = 3;

  // Hold the consumer's onStreamPart in a ref so the transport memo doesn't
  // need it as a dep — keeping the transport identity stable across renders
  // even when the caller passes an inline callback.
  const onStreamPartRef = useRef(onStreamPartOverride);
  onStreamPartRef.current = onStreamPartOverride;

  const isNewChat = initialMessagesRef.current.length === 0;
  const didFetchHistoryOnNewChat = useRef(false);
  const fetchChatHistory = useCallback(() => {
    mutate(
      unstable_serialize((pageIndex: number, previousPageData: unknown) =>
        getChatHistoryPaginationKey(apiBase, pageIndex, previousPageData),
      ),
    );
  }, [mutate, apiBase]);

  const [streamTitle, setStreamTitle] = useState<string | undefined>();
  const [titlePending, setTitlePending] = useState(false);
  const displayTitle = externalTitle ?? streamTitle;

  const chatApiUrl = apiOverride ?? apiUrl(apiBase, "/");

  // Default body builder used when the consumer doesn't supply their own
  // `prepareSendMessagesRequest`. Matches AppKit's agents plugin
  // `vercelAIChatRequestSchema` shape (`{ id, messages, trigger }`).
  // Consumers targeting a different server pass `prepareSendMessagesRequest`.
  const defaultPrepareSendMessagesRequest = useMemo<
    PrepareSendMessagesRequest<TMessage>
  >(
    () =>
      ({ messages, id: msgId, body, trigger }) => ({
        body: {
          id: msgId,
          messages,
          trigger,
          ...body,
        },
      }),
    [],
  );

  const prepareSendMessagesRequest =
    prepareSendMessagesRequestOverride ?? defaultPrepareSendMessagesRequest;

  const transport = useMemo(
    () =>
      new ChatTransport<TMessage>({
        api: chatApiUrl,
        headers,
        // Pass `fetchWithErrorHandlers` straight through. It forwards `init`
        // verbatim to `fetch`, so the AbortSignal that `useChat` plumbs in
        // for its native `stop()` and unmount cleanup is preserved.
        fetch: fetchWithErrorHandlers,
        prepareSendMessagesRequest,
        prepareReconnectToStreamRequest({ id: streamId }) {
          return {
            api: apiUrl(apiBase, `/${streamId}/stream`),
            credentials: "include",
          };
        },
        onStreamPart: (part) => {
          if (isNewChat && !didFetchHistoryOnNewChat.current) {
            fetchChatHistory();
            if (chatHistoryEnabled) {
              setTitlePending(true);
            }
            didFetchHistoryOnNewChat.current = true;

            if (chatHistoryEnabled && onNavigate) {
              onNavigate(id);
            }
          }
          resumeAttemptCountRef.current = 0;
          setLastPart(part);
          onStreamPartRef.current?.(part);
        },
      }),
    [
      apiBase,
      chatApiUrl,
      chatHistoryEnabled,
      fetchChatHistory,
      headers,
      id,
      isNewChat,
      onNavigate,
      prepareSendMessagesRequest,
    ],
  );

  const chatResult = useAiChat<TMessage>({
    id,
    messages: initialMessagesRef.current,
    experimental_throttle: 100,
    generateId: generateUUID,
    resume: id !== undefined && initialMessagesRef.current.length > 0,
    transport,
    onData: (dataPart) => {
      if (dataPart.type === "data-usage") {
        setUsage(dataPart.data as LanguageModelUsage);
      }
      if (dataPart.type === "data-title") {
        const title = dataPart.data as string;
        setStreamTitle(title);
        setTitlePending(false);
        fetchChatHistory();
        onTitleGenerated?.(title);
      }
      onDataOverride?.(dataPart);
    },
    onFinish: ({
      isAbort,
      isDisconnect,
      isError,
      messages: finishedMessages,
    }) => {
      didFetchHistoryOnNewChat.current = false;
      setTitlePending(false);

      if (isAbort) {
        fetchChatHistory();
        return;
      }

      const lastMessage = finishedMessages?.[finishedMessages.length - 1];
      const hasOAuthError = (
        lastMessage?.parts as
          | Array<{ type: string; data?: unknown }>
          | undefined
      )?.some(
        (part) =>
          part.type === "data-error" &&
          typeof part.data === "string" &&
          isCredentialErrorMessage(part.data),
      );

      if (hasOAuthError) {
        fetchChatHistory();
        chatResult.clearError();
        return;
      }

      const streamIncomplete = lastPartRef.current?.type !== "finish";
      const shouldResume =
        streamIncomplete &&
        (isDisconnect || isError || lastPartRef.current === undefined);

      if (shouldResume && resumeAttemptCountRef.current < maxResumeAttempts) {
        resumeAttemptCountRef.current++;
        queueMicrotask(() => {
          chatResult.resumeStream();
        });
      } else {
        if (resumeAttemptCountRef.current >= maxResumeAttempts) {
          console.warn("[useChat] Max resume attempts reached");
        }
        fetchChatHistory();
      }
    },
    onError: (error) => {
      if (error instanceof ChatError) {
        console.warn("[useChat] Chat error:", error.message);
      } else {
        console.warn("[useChat] Error during streaming:", error.message);
      }
      onErrorCb?.(error);
    },
  });

  return {
    ...chatResult,
    id,
    title: displayTitle,
    isTitleLoading: titlePending && !displayTitle,
    isReadonly,
    feedback,
    visibilityType,
    model,
  };
}

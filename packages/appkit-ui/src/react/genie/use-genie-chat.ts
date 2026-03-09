import { useCallback, useEffect, useRef, useState } from "react";
import { connectSSE } from "@/js";
import type {
  GenieChatStatus,
  GenieMessageItem,
  GenieMessageResponse,
  GenieStreamEvent,
  UseGenieChatOptions,
  UseGenieChatReturn,
} from "./types";

function getUrlParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function setUrlParam(name: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState({}, "", url.toString());
}

function removeUrlParam(name: string): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  window.history.replaceState({}, "", url.toString());
}

/**
 * The Genie API puts the user's question in `message.content` and the
 * actual AI answer in text attachments. Extract the text attachment
 * content so we display the real answer, not the question echo.
 */
function extractAssistantContent(msg: GenieMessageResponse): string {
  const textParts = (msg.attachments ?? [])
    .map((att) => att.text?.content)
    .filter(Boolean) as string[];
  return textParts.length > 0 ? textParts.join("\n\n") : msg.content;
}

function makeUserItem(
  msg: GenieMessageResponse,
  idSuffix = "",
): GenieMessageItem {
  return {
    id: `${msg.messageId}${idSuffix}`,
    role: "user",
    content: msg.content,
    status: msg.status,
    attachments: [],
    queryResults: new Map(),
  };
}

function makeAssistantItem(msg: GenieMessageResponse): GenieMessageItem {
  return {
    id: msg.messageId,
    role: "assistant",
    content: extractAssistantContent(msg),
    status: msg.status,
    attachments: msg.attachments ?? [],
    queryResults: new Map(),
    error: msg.error,
  };
}

/**
 * The API bundles user question (content) and AI answer (attachments) in one message.
 * Split into separate user + assistant items for display.
 */
function messageResultToItems(msg: GenieMessageResponse): GenieMessageItem[] {
  const hasAttachments = (msg.attachments?.length ?? 0) > 0;
  if (!hasAttachments) return [makeUserItem(msg)];
  return [makeUserItem(msg, "-user"), makeAssistantItem(msg)];
}

/**
 * Streams a conversation page via SSE. Collects message items and query
 * results into a buffer and returns them when the stream completes.
 */
function fetchConversationPage(
  basePath: string,
  alias: string,
  convId: string,
  options: {
    pageToken?: string;
    signal?: AbortSignal;
    onPaginationInfo?: (nextPageToken: string | null) => void;
    onError?: (error: string) => void;
    onConnectionError?: (err: unknown) => void;
  },
): Promise<GenieMessageItem[]> {
  const params = new URLSearchParams({
    requestId: crypto.randomUUID(),
  });
  if (options.pageToken) {
    params.set("pageToken", options.pageToken);
  }

  const items: GenieMessageItem[] = [];
  return connectSSE({
    url: `${basePath}/${encodeURIComponent(alias)}/conversations/${encodeURIComponent(convId)}?${params}`,
    signal: options.signal,
    onMessage: async (message) => {
      try {
        const event = JSON.parse(message.data) as GenieStreamEvent;
        switch (event.type) {
          case "message_result":
            items.push(...messageResultToItems(event.message));
            break;
          case "query_result":
            for (let i = items.length - 1; i >= 0; i--) {
              const item = items[i];
              if (
                item.attachments.some(
                  (a) => a.attachmentId === event.attachmentId,
                )
              ) {
                item.queryResults.set(event.attachmentId, event.data);
                break;
              }
            }
            break;
          case "history_info":
            options.onPaginationInfo?.(event.nextPageToken);
            break;
          case "error":
            options.onError?.(event.error);
            break;
        }
      } catch {
        // Malformed SSE data
      }
    },
    onError: (err) => options.onConnectionError?.(err),
  }).then(() => items);
}

/** Minimum time (ms) to hold the loading-older state so scroll inertia settles before prepending messages. */
const MIN_PREVIOUS_PAGE_LOAD_MS = 800;

/**
 * Manages the full Genie chat lifecycle:
 * SSE streaming, conversation persistence via URL, and history replay.
 *
 * @example
 * ```tsx
 * const { messages, status, sendMessage, reset } = useGenieChat({ alias: "demo" });
 * ```
 */
export function useGenieChat(options: UseGenieChatOptions): UseGenieChatReturn {
  const {
    alias,
    basePath = "/api/genie",
    persistInUrl = true,
    urlParamName = "conversationId",
  } = options;

  const [messages, setMessages] = useState<GenieMessageItem[]>([]);
  const [status, setStatus] = useState<GenieChatStatus>("idle");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);

  const hasPreviousPage = nextPageToken !== null;
  const isFetchingPreviousPage = status === "loading-older";

  const abortControllerRef = useRef<AbortController | null>(null);
  const paginationAbortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const nextPageTokenRef = useRef<string | null>(null);
  const isLoadingOlderRef = useRef(false);

  useEffect(() => {
    conversationIdRef.current = conversationId;
    nextPageTokenRef.current = nextPageToken;
  }, [conversationId, nextPageToken]);

  /** Process SSE events during live message streaming (sendMessage). */
  const processStreamEvent = useCallback(
    (event: GenieStreamEvent) => {
      switch (event.type) {
        case "message_start": {
          setConversationId(event.conversationId);
          if (persistInUrl) {
            setUrlParam(urlParamName, event.conversationId);
          }
          break;
        }

        case "status": {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, status: event.status }];
            }
            return prev;
          });
          break;
        }

        case "message_result": {
          const msg = event.message;
          const hasAttachments = (msg.attachments?.length ?? 0) > 0;

          if (hasAttachments) {
            // During streaming we already appended the user message locally,
            // so only handle assistant results. Messages without attachments
            // are the user-message echo from the API — skip those.
            const item = makeAssistantItem(msg);
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.id === "") {
                return [...prev.slice(0, -1), item];
              }
              return [...prev, item];
            });
          }
          break;
        }

        case "query_result": {
          setMessages((prev) => {
            // Reverse scan — query results typically match recent messages
            for (let i = prev.length - 1; i >= 0; i--) {
              const msg = prev[i];
              if (
                msg.attachments.some(
                  (a) => a.attachmentId === event.attachmentId,
                )
              ) {
                const updated = prev.slice();
                updated[i] = {
                  ...msg,
                  queryResults: new Map(msg.queryResults).set(
                    event.attachmentId,
                    event.data,
                  ),
                };
                return updated;
              }
            }
            return prev;
          });
          break;
        }

        case "error": {
          setError(event.error);
          setStatus("error");
          break;
        }
      }
    },
    [persistInUrl, urlParamName],
  );

  const sendMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      abortControllerRef.current?.abort();
      paginationAbortRef.current?.abort();
      setError(null);
      setStatus("streaming");

      const userMessage: GenieMessageItem = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        status: "COMPLETED",
        attachments: [],
        queryResults: new Map(),
      };

      const assistantPlaceholder: GenieMessageItem = {
        id: "",
        role: "assistant",
        content: "",
        status: "ASKING_AI",
        attachments: [],
        queryResults: new Map(),
      };

      setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const requestId = crypto.randomUUID();

      connectSSE({
        url: `${basePath}/${encodeURIComponent(alias)}/messages?requestId=${encodeURIComponent(requestId)}`,
        payload: {
          content: trimmed,
          conversationId: conversationIdRef.current ?? undefined,
        },
        signal: abortController.signal,
        onMessage: async (message) => {
          try {
            processStreamEvent(JSON.parse(message.data) as GenieStreamEvent);
          } catch {
            // Malformed SSE data
          }
        },
        onError: (err) => {
          if (abortController.signal.aborted) return;
          setError(
            err instanceof Error
              ? err.message
              : "Connection error. Please try again.",
          );
          setStatus("error");
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last?.role === "assistant" && last.id === ""
              ? prev.slice(0, -1)
              : prev;
          });
        },
      }).then(() => {
        if (!abortController.signal.aborted) {
          setStatus((prev) => (prev === "error" ? "error" : "idle"));
        }
      });
    },
    [alias, basePath, processStreamEvent],
  );

  /** Creates an AbortController, stores it in the given ref, and fetches a conversation page. */
  const fetchPage = useCallback(
    (
      controllerRef: { current: AbortController | null },
      convId: string,
      options?: { pageToken?: string; errorMessage?: string },
    ) => {
      controllerRef.current?.abort();
      const abortController = new AbortController();
      controllerRef.current = abortController;

      const promise = fetchConversationPage(basePath, alias, convId, {
        pageToken: options?.pageToken,
        signal: abortController.signal,
        onPaginationInfo: setNextPageToken,
        onError: (msg) => {
          setError(msg);
          setStatus("error");
        },
        onConnectionError: (err) => {
          if (abortController.signal.aborted) return;
          setError(
            err instanceof Error
              ? err.message
              : (options?.errorMessage ?? "Failed to load messages."),
          );
          setStatus("error");
        },
      });

      return { promise, abortController };
    },
    [alias, basePath],
  );

  const loadHistory = useCallback(
    (convId: string) => {
      paginationAbortRef.current?.abort();
      setStatus("loading-history");
      setError(null);
      setMessages([]);
      setConversationId(convId);

      const { promise, abortController } = fetchPage(
        abortControllerRef,
        convId,
        { errorMessage: "Failed to load conversation history." },
      );
      promise.then((items) => {
        if (!abortController.signal.aborted) {
          setMessages(items);
          setStatus((prev) => (prev === "error" ? "error" : "idle"));
        }
      });
    },
    [fetchPage],
  );

  const fetchPreviousPage = useCallback(() => {
    if (
      !nextPageTokenRef.current ||
      !conversationIdRef.current ||
      isLoadingOlderRef.current
    )
      return;

    isLoadingOlderRef.current = true;
    setStatus("loading-older");
    setError(null);

    const startTime = Date.now();
    const { promise, abortController } = fetchPage(
      paginationAbortRef,
      conversationIdRef.current,
      {
        pageToken: nextPageTokenRef.current,
        errorMessage: "Failed to load older messages.",
      },
    );
    promise
      .then(async (items) => {
        if (abortController.signal.aborted) return;
        const elapsed = Date.now() - startTime;
        if (elapsed < MIN_PREVIOUS_PAGE_LOAD_MS) {
          await new Promise((r) =>
            setTimeout(r, MIN_PREVIOUS_PAGE_LOAD_MS - elapsed),
          );
        }
        if (abortController.signal.aborted) return;
        if (items.length > 0) {
          setMessages((prev) => [...items, ...prev]);
        }
        setStatus((current) =>
          current === "loading-older" ? "idle" : current,
        );
      })
      .finally(() => {
        isLoadingOlderRef.current = false;
      });
  }, [fetchPage]);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    paginationAbortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    setError(null);
    setStatus("idle");
    setNextPageToken(null);
    if (persistInUrl) {
      removeUrlParam(urlParamName);
    }
  }, [persistInUrl, urlParamName]);

  useEffect(() => {
    if (!persistInUrl) return;
    const existingId = getUrlParam(urlParamName);
    if (existingId) {
      loadHistory(existingId);
    }
    return () => {
      abortControllerRef.current?.abort();
      paginationAbortRef.current?.abort();
    };
  }, [persistInUrl, urlParamName, loadHistory]);

  return {
    messages,
    status,
    conversationId,
    error,
    sendMessage,
    reset,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
  };
}

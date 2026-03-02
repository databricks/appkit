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

  const abortControllerRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const processEvent = useCallback(
    (event: GenieStreamEvent, isHistory: boolean) => {
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

          if (isHistory) {
            const items = messageResultToItems(msg);
            setMessages((prev) => [...prev, ...items]);
          } else if (hasAttachments) {
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
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              const msg = updated[i];
              if (
                msg.attachments.some(
                  (a) => a.attachmentId === event.attachmentId,
                )
              ) {
                const queryResults = new Map(msg.queryResults);
                queryResults.set(event.attachmentId, event.data);
                updated[i] = { ...msg, queryResults };
                break;
              }
            }
            return updated;
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
            processEvent(JSON.parse(message.data) as GenieStreamEvent, false);
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
    [alias, basePath, processEvent],
  );

  const loadHistory = useCallback(
    (convId: string) => {
      abortControllerRef.current?.abort();
      setStatus("loading-history");
      setError(null);
      setMessages([]);
      setConversationId(convId);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const requestId = crypto.randomUUID();

      connectSSE({
        url: `${basePath}/${encodeURIComponent(alias)}/conversations/${encodeURIComponent(convId)}?requestId=${encodeURIComponent(requestId)}`,
        signal: abortController.signal,
        onMessage: async (message) => {
          try {
            processEvent(JSON.parse(message.data) as GenieStreamEvent, true);
          } catch {
            // Malformed SSE data
          }
        },
        onError: (err) => {
          if (abortController.signal.aborted) return;
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load conversation history.",
          );
          setStatus("error");
        },
      }).then(() => {
        if (!abortController.signal.aborted) {
          setStatus((prev) => (prev === "error" ? "error" : "idle"));
        }
      });
    },
    [alias, basePath, processEvent],
  );

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    setError(null);
    setStatus("idle");
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
    };
  }, [persistInUrl, urlParamName, loadHistory]);

  return { messages, status, conversationId, error, sendMessage, reset };
}

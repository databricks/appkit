import { useCallback, useRef, useState } from "react";
import { connectSSE } from "@/js";
import type {
  GenieSpaceResultItem,
  MultiGenieChatStatus,
  MultiGenieMessageItem,
  MultiGenieStreamEvent,
  UseMultiGenieChatOptions,
  UseMultiGenieChatReturn,
} from "./types";

export function useMultiGenieChat(
  options: UseMultiGenieChatOptions = {},
): UseMultiGenieChatReturn {
  const { basePath = "/api/multiGenie" } = options;

  const [messages, setMessages] = useState<MultiGenieMessageItem[]>([]);
  const [status, setStatus] = useState<MultiGenieChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  // Accumulates genie space results across SSE events for the current request,
  // then snapshots into the message item when the final "answer" arrives.
  const genieSpaceResultsRef = useRef<GenieSpaceResultItem[]>([]);

  const processEvent = useCallback((event: MultiGenieStreamEvent) => {
    switch (event.type) {
      case "agent_start":
      case "agent_thinking": {
        setStatus("thinking");
        break;
      }

      case "routing": {
        setStatus("routing");
        break;
      }

      case "genie_space_result": {
        setStatus("querying");
        genieSpaceResultsRef.current = [
          ...genieSpaceResultsRef.current,
          {
            alias: event.alias,
            spaceId: event.spaceId,
            conversationId: event.conversationId,
            messageId: event.messageId,
            content: event.content,
            attachments: event.attachments,
            queryResults: new Map(),
            status: event.status,
          },
        ];
        break;
      }

      case "genie_query_result": {
        genieSpaceResultsRef.current = genieSpaceResultsRef.current.map(
          (sr) => {
            if (sr.alias !== event.alias) return sr;
            if (
              !sr.attachments.some((a) => a.attachmentId === event.attachmentId)
            )
              return sr;
            const queryResults = new Map(sr.queryResults);
            queryResults.set(event.attachmentId, event.data);
            return { ...sr, queryResults };
          },
        );
        break;
      }

      case "genie_space_error": {
        genieSpaceResultsRef.current = [
          ...genieSpaceResultsRef.current,
          {
            alias: event.alias,
            spaceId: "",
            conversationId: "",
            messageId: "",
            content: "",
            attachments: [],
            queryResults: new Map(),
            status: "ERROR",
            error: event.error,
          },
        ];
        break;
      }

      case "answer": {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const item: MultiGenieMessageItem = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: event.content,
            genieSpaceResults: [...genieSpaceResultsRef.current],
          };
          // Replace placeholder if present
          if (last?.role === "assistant" && last.id === "") {
            return [...prev.slice(0, -1), item];
          }
          return [...prev, item];
        });
        break;
      }

      case "error": {
        setError(event.error);
        setStatus("error");
        break;
      }
    }
  }, []);

  const sendMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      abortControllerRef.current?.abort();
      setError(null);
      setStatus("thinking");
      genieSpaceResultsRef.current = [];

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: trimmed,
          genieSpaceResults: [],
        },
        { id: "", role: "assistant", content: "", genieSpaceResults: [] },
      ]);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      connectSSE({
        url: `${basePath}/messages`,
        payload: { content: trimmed },
        signal: abortController.signal,
        onMessage: async (message) => {
          try {
            processEvent(JSON.parse(message.data) as MultiGenieStreamEvent);
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
          // Remove assistant placeholder on connection error
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
    [basePath, processEvent],
  );

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setError(null);
    setStatus("idle");
    genieSpaceResultsRef.current = [];
  }, []);

  return { messages, status, error, sendMessage, reset };
}

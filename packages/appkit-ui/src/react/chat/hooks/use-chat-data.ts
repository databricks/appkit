import { useMemo } from "react";
import useSWR from "swr";
import { useChatContext } from "../context";
import { convertToChatMessages } from "../lib/messages";
import { apiUrl } from "../lib/utils";
import type { Chat, ChatFeedbackMap, ChatMessage } from "../types";

interface ChatData {
  chat: Chat;
  messages: ChatMessage[];
  feedback: ChatFeedbackMap;
}

function createFetchChatData(apiBase: string) {
  return async function fetchChatData(url: string): Promise<ChatData | null> {
    const chatId = url.split("/").pop();

    const chatResponse = await fetch(apiUrl(apiBase, `/${chatId}`));

    if (!chatResponse.ok) {
      if (chatResponse.status === 404 || chatResponse.status === 403) {
        return null;
      }
      throw new Error("Failed to load chat");
    }

    const chat = await chatResponse.json();

    const messagesResponse = await fetch(
      apiUrl(apiBase, `/messages/${chatId}`),
    );

    if (!messagesResponse.ok) {
      if (messagesResponse.status === 404) {
        return { chat, messages: [], feedback: {} };
      }
      throw new Error("Failed to load messages");
    }

    const messagesFromDb = await messagesResponse.json();
    const messages = convertToChatMessages(messagesFromDb);

    let feedbackMap: ChatFeedbackMap = {};
    try {
      const feedbackResponse = await fetch(
        apiUrl(apiBase, `/feedback/chat/${chatId}`),
      );
      if (feedbackResponse.ok) {
        feedbackMap = await feedbackResponse.json();
      }
    } catch (error) {
      console.warn("Failed to fetch feedback:", error);
    }

    return { chat, messages, feedback: feedbackMap };
  };
}

export function useChatData(chatId: string | undefined, enabled = true) {
  const { apiBase } = useChatContext();
  const fetchFn = useMemo(() => createFetchChatData(apiBase), [apiBase]);

  const { data, error, isLoading, mutate } = useSWR<ChatData | null>(
    chatId && enabled ? `/chat/${chatId}` : null,
    fetchFn,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      keepPreviousData: true,
      dedupingInterval: 2000,
    },
  );

  return {
    chatData: data,
    isLoading,
    error: error
      ? "Failed to load chat"
      : data === null && !isLoading
        ? "Chat not found or you do not have access"
        : null,
    mutate,
  };
}

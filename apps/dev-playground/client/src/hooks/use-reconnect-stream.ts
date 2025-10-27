import { useEffect, useRef, useState } from "react";

interface Message {
  type: string;
  count: number;
  total: number;
  timestamp: string;
  content: string;
}

async function connectSSE({
  url,
  onMessage,
  signal,
  lastEventId = null,
}: {
  url: string;
  onMessage: (message: { id: string; data: string }) => void;
  signal: AbortSignal;
  lastEventId?: string | null;
}) {
  const headers: HeadersInit = {
    Accept: "text/event-stream",
  };

  if (lastEventId) {
    headers["Last-Event-ID"] = lastEventId;
  }

  try {
    const response = await fetch(url, {
      headers,
      method: "GET",
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }
      const decoded = decoder.decode(value, { stream: true });
      if (buffer.length + decoded.length > MAX_BUFFER_SIZE) {
        throw new Error("Buffer size exceeded");
      }

      buffer += decoded;

      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        let id = "";
        let data = "";

        part.split("\n").forEach((line) => {
          if (line.startsWith("id: ")) {
            id = line.replace(/^id: /, "");
          } else if (line.startsWith("data: ")) {
            data = line.replace(/^data: /, "");
          }
        });

        if (id) {
          lastEventId = id;
        }

        if (data) {
          onMessage({ id: lastEventId || "", data });
        }
      }
    }
  } catch (_err: any) {
    let resolve: (v?: any) => void;
    const promise = new Promise((r) => {
      resolve = r;
    });
    setTimeout(async () => {
      await connectSSE({ url, lastEventId, onMessage, signal });
      resolve();
    }, 2000);
    return promise;
  }
}

export function useReconnectStream(url: string, resetTrigger = 0) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<string>("Connecting...");
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const hasDisconnectedRef = useRef(false);
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    void resetTrigger; // dependcy to trigger effect reset
    setMessages([]);
    setStatus("Connecting...");
    lastEventIdRef.current = null;
    hasDisconnectedRef.current = false;
    sessionIdRef.current = crypto.randomUUID();

    const isCurrentStreamRef = { current: true };

    const startStream = async () => {
      if (!isCurrentStreamRef.current) {
        return;
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      setStatus(hasDisconnectedRef.current ? "Reconnected" : "Connected");

      try {
        await connectSSE({
          url: `${url}?sessionId=${sessionIdRef.current}`,
          onMessage: (msg) => {
            lastEventIdRef.current = msg.id;
            try {
              const parsed = JSON.parse(msg.data) as Message;
              if (
                typeof parsed.type === "string" &&
                typeof parsed.count === "number" &&
                typeof parsed.total === "number" &&
                typeof parsed.timestamp === "string" &&
                typeof parsed.content === "string"
              ) {
                const message = parsed;
                setMessages((prev) => [...prev, message]);

                if (message.count === 2 && !hasDisconnectedRef.current) {
                  setTimeout(() => {
                    setStatus("Disconnected (testing reconnection)");
                    hasDisconnectedRef.current = true;
                    abortControllerRef.current?.abort();
                    setTimeout(() => {
                      startStream();
                    }, 3000);
                  }, 1000);
                }

                if (message.count === 5) {
                  setStatus("Completed");
                  abortControllerRef.current?.abort();
                }
              } else {
                console.error("Invalid message format:", msg.data);
              }
            } catch (error) {
              console.error("Error parsing message:", error);
            }
          },
          signal: abortControllerRef.current?.signal,
          lastEventId: lastEventIdRef.current,
        });
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Stream error:", err);
          setStatus("Error");
        }
      }
    };

    startStream();

    return () => {
      isCurrentStreamRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, [url, resetTrigger]);

  return { messages, status };
}

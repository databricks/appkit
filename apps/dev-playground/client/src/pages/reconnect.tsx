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

  console.log("Connecting to SSE...", { url, lastEventId });

  if (lastEventId) {
    headers["Last-Event-ID"] = lastEventId;
    console.log("Reconnecting with Last-Event-ID:", lastEventId);
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
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log("Stream ended");
        break;
      }

      buffer += decoder.decode(value, { stream: true });

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
  } catch (err: any) {
    console.debug("Retrying in 2s...", {
      url,
      lastEventId,
      onMessage,
      signal,
    });
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

export function Reconnect() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<string>("Connecting...");
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const hasDisconnectedRef = useRef(false);

  useEffect(() => {
    const isCurrentStreamRef = { current: true };

    const startStream = async () => {
      if (!isCurrentStreamRef.current) {
        console.log("Stream cancelled before start");
        return;
      }

      if (abortControllerRef.current) {
        console.log("Aborting previous stream");
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      setStatus(hasDisconnectedRef.current ? "Reconnected" : "Connected");

      try {
        await connectSSE({
          url: "/api/reconnect/stream",
          onMessage: (msg) => {
            console.log("Received message:", msg.data, "id:", msg.id);
            lastEventIdRef.current = msg.id;

            const message = JSON.parse(msg.data) as Message;
            setMessages((prev) => [...prev, message]);

            // Test: disconnect after receiving 2 messages
            if (message.count === 2 && !hasDisconnectedRef.current) {
              console.log(
                "Received 2 messages, will disconnect in 1 second...",
              );
              setTimeout(() => {
                console.log("DISCONNECTING NOW");
                setStatus("Disconnected (testing reconnection)");
                hasDisconnectedRef.current = true;
                abortControllerRef.current?.abort();

                // Reconnect after 3 seconds
                setTimeout(() => {
                  console.log(
                    "RECONNECTING with lastEventId:",
                    lastEventIdRef.current,
                  );
                  startStream();
                }, 3000);
              }, 1000);
            }

            // Close after receiving all messages
            if (message.count === 5) {
              console.log("Received all 5 messages, closing");
              setStatus("Completed");
              abortControllerRef.current?.abort();
            }
          },
          signal: abortControllerRef.current.signal,
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
      console.log("Cleaning up - cancelling stream");
      isCurrentStreamRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  return (
    <div style={{ padding: "20px", fontFamily: "monospace" }}>
      <h2>Reconnect Stream Test</h2>
      <p>
        <strong>Status:</strong> {status}
      </p>
      <p>
        <strong>Messages received:</strong> {messages.length}
      </p>
      <div>
        <h3>Messages:</h3>
        {messages.length === 0 ? (
          <p>Waiting for messages...</p>
        ) : (
          <ul>
            {messages.map((msg) => (
              <li key={msg.timestamp}>
                [{msg.count}/{msg.total}] {msg.content} - {msg.timestamp}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        style={{
          marginTop: "20px",
          padding: "10px",
          background: "#f0f0f0",
          color: "black",
        }}
      >
        <strong>Test Plan:</strong>
        <ol>
          <li>Stream starts, sends message every 3 seconds</li>
          <li>After receiving 2 messages (~6 seconds), client disconnects</li>
          <li>After 3 seconds, client reconnects</li>
          <li>Should receive remaining messages (3, 4, 5)</li>
        </ol>
      </div>
    </div>
  );
}

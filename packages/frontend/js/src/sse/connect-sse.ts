export async function connectSSE({
  url,
  payload,
  onMessage,
  signal,
  lastEventId = null,
  retryDelay = 2000,
}: {
  url: string;
  arrowStreamUrl?: string;
  payload?: Record<string, any> | string;
  onMessage: (message: { id: string; data: string }) => void;
  signal: AbortSignal;
  lastEventId?: string | null;
  retryDelay?: number;
}) {
  const headers: HeadersInit = {};

  if (payload) {
    headers["Content-Type"] = "application/json";
  } else {
    headers.Accept = "text/event-stream";
  }

  if (lastEventId) {
    headers["Last-Event-ID"] = lastEventId;
  }

  const method = payload ? "POST" : "GET";
  const body = payload
    ? typeof payload === "string"
      ? payload
      : JSON.stringify(payload)
    : undefined;

  try {
    const response = await fetch(url, {
      headers,
      method,
      body,
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
      await connectSSE({
        url,
        lastEventId,
        onMessage,
        signal,
        payload,
        retryDelay,
      });
      resolve();
    }, retryDelay);
    return promise;
  }
}

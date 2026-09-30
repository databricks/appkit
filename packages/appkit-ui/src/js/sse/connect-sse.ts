import type { ConnectSSEOptions, SSEMessage } from "./types";

/**
 * Connects to an SSE endpoint with automatic retries and exponential backoff
 * @param options - SSE connection options
 * @param attempt - Internal retry attempt counter
 * @returns Promise that resolves when the stream ends or retries stop
 */
export async function connectSSE<Payload = unknown>(
  options: ConnectSSEOptions<Payload>,
  attempt = 0,
) {
  const {
    url,
    payload,
    onMessage,
    signal,
    lastEventId: initialLastEventId = null,
    retryDelay = 2000,
    maxRetries = 3,
    // Matches the server's `streamDefaults.maxEventSize`: a smaller buffer here
    // turns a legal server event into "Buffer size exceeded" plus retries.
    maxBufferSize = 5 * 1024 * 1024,
    timeout = 300000, // 5 minutes
    onError,
  } = options;

  if (signal?.aborted) return;

  if (!url || url.trim().length <= 0) {
    throw new Error("connectSSE: 'url' must be a non-empty string.");
  }

  if (retryDelay <= 0) {
    throw new Error("connectSSE: 'retryDelay' must be >= 0.");
  }
  if (maxBufferSize <= 0) {
    throw new Error("connectSSE: 'maxBufferSize' must be > 0.");
  }
  const headers: HeadersInit = {
    Accept: "text/event-stream",
  };

  const hasPayload = typeof payload !== "undefined";

  if (hasPayload) {
    headers["Content-Type"] = "application/json";
  }

  let lastEventId = initialLastEventId;

  if (lastEventId) {
    headers["Last-Event-ID"] = lastEventId;
  }

  const method = hasPayload ? "POST" : "GET";
  const body = hasPayload
    ? typeof payload === "string"
      ? payload
      : JSON.stringify(payload)
    : undefined;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

  const combined = signal
    ? createCombinedSignal(signal, timeoutController.signal)
    : { signal: timeoutController.signal, cleanup: () => {} };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let retry = false;

  try {
    const response = await fetch(url, {
      headers,
      method,
      body,
      signal: combined.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const decoded = decoder.decode(value, { stream: true });

      if (buffer.length + decoded.length > maxBufferSize) {
        throw new Error("Buffer size exceeded");
      }
      buffer += decoded;

      const normalizedBuffer = buffer.replace(/\r\n/g, "\n");
      const parts = normalizedBuffer.split("\n\n");

      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const message = parseSSEEvent(part);
        if (!message) continue;

        if (message.id) lastEventId = message.id;

        await onMessage({
          id: lastEventId ?? "",
          data: message.data,
        });
        if (signal?.aborted) return;
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    if (onError) onError(error, attempt < maxRetries);
    if (signal?.aborted) return;

    if (attempt >= maxRetries) {
      console.warn(
        `[connectSSE] Max retries (${maxRetries}) exceeded for ${url}`,
      );
      return;
    }

    retry = true;
  } finally {
    clearTimeout(timeoutId);
    combined.cleanup();
    // Release the current response before reconnecting or settling. A parse
    // failure can leave unread bytes even if fetch itself did not fail.
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  if (retry && !signal?.aborted) {
    const nextAttempt = attempt + 1;
    await waitForRetry(
      computeExponentialDelay(nextAttempt, retryDelay),
      signal,
    );
    if (!signal?.aborted) {
      await connectSSE({ ...options, lastEventId }, nextAttempt);
    }
  }
}

/**
 * Parses a raw SSE event chunk into a message
 * @param chunk - Raw SSE event block
 * @returns Parsed message or null when no data lines are present
 * @private
 */
function parseSSEEvent(chunk: string): SSEMessage | null {
  const normalized = chunk.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line === "") continue;
    if (line.startsWith(":")) continue;

    if (line.startsWith("id:")) {
      id = line.slice(3).trimStart();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;

  return {
    id: id ?? "",
    data: dataLines.join("\n"),
  };
}

/**
 * Compute exponential backoff delay in milliseconds.
 * Uses a random jitter factor to avoid thundering herd problem.
 * @param attempt - Retry attempt number (1-based)
 * @param baseDelayMs - Base delay in milliseconds
 * @returns Delay in milliseconds for this attempt
 */
function computeExponentialDelay(attempt: number, baseDelayMs: number): number {
  const safeAttempt = Math.max(1, attempt);
  const multiplier = Math.min(2 ** (safeAttempt - 1), 32);
  const rawDelayMs = baseDelayMs * multiplier;

  const jitter = rawDelayMs * 0.2;
  const randomizedDelayMs = rawDelayMs + Math.random() * jitter;

  return Math.max(0, Math.floor(randomizedDelayMs));
}

/**
 * Combines two abort signals into a single abort signal
 * @param signal1 - First abort signal
 * @param signal2 - Second abort signal
 * @returns Combined signal
 */
function createCombinedSignal(
  signal1: AbortSignal,
  signal2: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort1 = () => controller.abort(signal1.reason);
  const abort2 = () => controller.abort(signal2.reason);
  if (signal1.aborted) abort1();
  else if (signal2.aborted) abort2();
  else {
    signal1.addEventListener("abort", abort1, { once: true });
    signal2.addEventListener("abort", abort2, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      signal1.removeEventListener("abort", abort1);
      signal2.removeEventListener("abort", abort2);
    },
  };
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

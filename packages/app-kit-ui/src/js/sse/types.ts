/** Single SSE message payload. */
export type SSEMessage = {
  /** Event id from server */
  id: string;
  /** Raw data payload */
  data: string;
};

/** Options for opening a resilient SSE connection */
export interface ConnectSSEOptions<Payload = unknown> {
  /** SSE endpoint URL */
  url: string;
  /** Optional request payload for POST */
  payload?: Payload | string;
  /** Called for each SSE message. */
  onMessage: (message: SSEMessage) => void;
  /** Abort signal to stop streaming and retries. */
  signal?: AbortSignal;
  /** Last event id used to resume the stream. */
  lastEventId?: string | null;
  /** Base delay in ms for retry backoff. */
  retryDelay?: number;
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Request timeout in ms */
  timeout?: number;
  /** Max in-memory buffer size before error. */
  maxBufferSize?: number;
  /** Called when a connection or parsing error occurs. */
  onError?: (error: unknown) => void;
}

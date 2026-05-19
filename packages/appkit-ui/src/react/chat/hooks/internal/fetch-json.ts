import type { Message, Thread } from "shared";

/** Same shape as `Thread`, but with date fields as JSON-encoded strings. */
export interface SerializedMessage extends Omit<Message, "createdAt"> {
  createdAt: string;
}

export interface SerializedThread
  extends Omit<Thread, "createdAt" | "updatedAt" | "messages"> {
  createdAt: string;
  updatedAt: string;
  messages: SerializedMessage[];
}

export type HeadersOption =
  | HeadersInit
  | (() => HeadersInit | Promise<HeadersInit>);

interface FetchJsonOptions {
  signal?: AbortSignal;
  headers?: HeadersOption;
}

async function resolveHeaders(
  headers: HeadersOption | undefined,
): Promise<HeadersInit | undefined> {
  if (!headers) return undefined;
  if (typeof headers === "function") return await headers();
  return headers;
}

/**
 * Minimal abortable JSON GET helper used by the thread-history hooks.
 *
 * Throws a plain `Error` on non-2xx responses (message taken from the
 * response body's `error` field, falling back to `HTTP <status>`). Lets
 * `AbortError` propagate so callers can identify cancellations via
 * `err.name === "AbortError"`.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const headers = await resolveHeaders(options.headers);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", ...(headers ?? {}) },
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function reviveThread(raw: SerializedThread): Thread {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    messages: raw.messages.map((m) => ({
      ...m,
      createdAt: new Date(m.createdAt),
    })),
  };
}

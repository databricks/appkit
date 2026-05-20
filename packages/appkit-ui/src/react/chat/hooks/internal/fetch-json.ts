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

interface MutateJsonOptions {
  method: "POST" | "DELETE" | "PUT" | "PATCH";
  /** Optional JSON-serializable body. Sets `Content-Type: application/json`. */
  body?: unknown;
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

async function throwResponseError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  const message =
    (body as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
  throw new Error(message);
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
  if (!response.ok) await throwResponseError(response);
  return (await response.json()) as T;
}

/**
 * Mutation sibling of {@link fetchJson} — same error semantics, but
 * supports non-GET methods and an optional JSON body. Returns the
 * parsed response when the server sends one, or `undefined` for empty /
 * `204 No Content` responses.
 */
export async function mutateJson<T = unknown>(
  url: string,
  options: MutateJsonOptions,
): Promise<T | undefined> {
  const extraHeaders = await resolveHeaders(options.headers);
  const hasBody = options.body !== undefined;
  const init: RequestInit = {
    method: options.method,
    signal: options.signal,
    headers: {
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders ?? {}),
    },
  };
  if (hasBody) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (!response.ok) await throwResponseError(response);
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
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

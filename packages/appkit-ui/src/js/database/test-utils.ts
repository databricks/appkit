import { vi } from "vitest";

import { _resetConfigCache } from "../config";
import { DATABASE_ACTOR_HEADER, resetDatabaseSession } from "./session";

/** Which operations the boot payload publishes: URLs and methods by name. */
interface PublishedOperations {
  endpoints?: Record<string, string>;
  operations?: Record<string, string>;
}

/** The URL `Plugin.route` registers for an operation in these tests. */
export function operationPath(name: string): string {
  return `/api/database/operations/${encodeURIComponent(name)}`;
}

/** Publish named operations the way the server's boot payload carries them. */
export function publishOperations(methods: Record<string, string>): void {
  publishBoot({
    endpoints: Object.fromEntries(
      Object.keys(methods).map((name) => [name, operationPath(name)]),
    ),
    operations: methods,
  });
}

export function publishBoot({ endpoints, operations }: PublishedOperations) {
  window.__appkit__ = {
    appName: "test",
    queries: {},
    endpoints: endpoints ? { database: endpoints } : {},
    plugins: operations ? { database: { operations } } : {},
  };
  _resetConfigCache();
  resetDatabaseSession();
}

export function resetDatabaseTestEnvironment(): void {
  vi.unstubAllGlobals();
  delete window.__appkit__;
  _resetConfigCache();
  resetDatabaseSession();
}

interface ReplyOptions {
  status?: number;
  /** The opaque actor header; `null` sends none. Default `"actor-a"`. */
  actor?: string | null;
  headers?: Record<string, string>;
}

export function reply(body: unknown, options: ReplyOptions = {}): Response {
  const { status = 200, actor = "actor-a", headers = {} } = options;
  const all = new Headers(headers);
  if (actor !== null) all.set(DATABASE_ACTOR_HEADER, actor);
  if (status === 204) return new Response(null, { status, headers: all });
  all.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: all });
}

/** One request the mocked `fetch` holds open until the test answers it. */
export interface PendingRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly cache: RequestCache | undefined;
  readonly signal: AbortSignal | undefined;
  /** The decoded `input` query parameter of a GET. */
  readonly input: unknown;
  respond(body?: unknown, options?: ReplyOptions): void;
  respondWith(response: Response): void;
  fail(error: unknown): void;
}

/**
 * Stub `fetch` so every request stays open until the test answers it, which
 * lets a test choose the order replies arrive in. Aborts are ignored, so a
 * test can still deliver a reply after its request was cancelled.
 */
export function mockDatabaseFetch() {
  const requests: PendingRequest[] = [];
  const fetchMock = vi.fn(
    (url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        const query = new URL(url, "http://localhost").searchParams.get(
          "input",
        );
        requests.push({
          url,
          method: init.method ?? "GET",
          headers: new Headers(init.headers),
          body: typeof init.body === "string" ? init.body : undefined,
          cache: init.cache,
          signal: init.signal ?? undefined,
          input: query === null ? undefined : JSON.parse(query),
          respond: (body, options) => resolve(reply(body, options)),
          respondWith: resolve,
          fail: reject,
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  /** The request sent `index`-th; throws when there is none. */
  const request = (index: number): PendingRequest => {
    const found = requests[index];
    if (!found) throw new Error(`no request #${index} was sent`);
    return found;
  };
  return { requests, fetchMock, request };
}

/** Let pending promise reactions run. */
export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { databaseApi as typedApi, type DatabaseRequestOptions } from "./client";
import { DatabaseApiError } from "./errors";
import {
  flush,
  mockDatabaseFetch,
  operationPath,
  publishBoot,
  publishOperations,
  reply,
  resetDatabaseTestEnvironment,
} from "./test-utils";

// This package has no generated registry, so every operation name is `never`
// here. The typed surface is compiled in use-database.types.test.ts; these
// tests drive the runtime through a string-typed view.
const databaseApi = typedApi as unknown as {
  execute(
    name: string,
    input: unknown,
    options?: DatabaseRequestOptions,
  ): Promise<unknown>;
};

const OPERATIONS = {
  "notes.get": "GET",
  "notes.create": "POST",
  "notes.update": "PATCH",
  "notes.replace": "PUT",
  "notes.delete": "DELETE",
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

let server: ReturnType<typeof mockDatabaseFetch>;

beforeEach(() => {
  server = mockDatabaseFetch();
  publishOperations(OPERATIONS);
});

afterEach(resetDatabaseTestEnvironment);

describe("resolving an operation", () => {
  test("refuses a name the server did not publish without sending a request", async () => {
    const error = await rejection(databaseApi.execute("boards.get", { id: 1 }));

    expect(error).toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({
      code: "NOT_EXPOSED",
      status: null,
      details: [],
      message: 'Database operation "boards.get" is not exposed',
    });
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a legacy CRUD route without operation metadata",
      { endpoints: { "notes.list": "/api/database/notes" } },
      "notes.list",
    ],
    [
      "a method without an endpoint",
      { operations: { "notes.get": "GET" } },
      "notes.get",
    ],
    [
      "an unknown method",
      {
        endpoints: { "notes.get": operationPath("notes.get") },
        operations: { "notes.get": "get" },
      },
      "notes.get",
    ],
    [
      "a cross-origin endpoint",
      {
        endpoints: { "notes.get": "https://elsewhere.example/notes" },
        operations: { "notes.get": "GET" },
      },
      "notes.get",
    ],
    [
      "a protocol-relative endpoint",
      {
        endpoints: { "notes.get": "//elsewhere.example/notes" },
        operations: { "notes.get": "GET" },
      },
      "notes.get",
    ],
    [
      "an endpoint a backslash turns protocol-relative",
      {
        endpoints: { "notes.get": "/\\elsewhere.example/notes" },
        operations: { "notes.get": "GET" },
      },
      "notes.get",
    ],
  ])(
    "refuses %s with NOT_EXPOSED and no request",
    async (_case, boot, name) => {
      publishBoot(boot);

      await expect(databaseApi.execute(name, { id: 1 })).rejects.toMatchObject({
        code: "NOT_EXPOSED",
      });
      expect(server.fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "never resolves %s through a prototype",
    async (name) => {
      await expect(databaseApi.execute(name, {})).rejects.toMatchObject({
        code: "NOT_EXPOSED",
      });
      expect(server.fetchMock).not.toHaveBeenCalled();
    },
  );

  test("calls the URL the server published, not a local convention", async () => {
    publishBoot({
      endpoints: { "notes.get": "/custom/base/read-note" },
      operations: { "notes.get": "GET" },
    });

    const pending = databaseApi.execute("notes.get", { id: 7 });
    server.request(0).respond({ id: 7 });
    await pending;

    expect(server.request(0).url).toBe(
      `/custom/base/read-note?input=${encodeURIComponent('{"id":7}')}`,
    );
  });
});

describe("sending input", () => {
  test("a GET carries its input as one JSON query value and no body", async () => {
    const pending = databaseApi.execute("notes.get", {
      id: 9007199254740993n,
      filter: { tags: ["a b", "c&d"] },
    });
    const request = server.request(0);
    request.respond({ id: "9007199254740993", body: "hi" });

    await expect(pending).resolves.toEqual({
      id: "9007199254740993",
      body: "hi",
    });
    const url = new URL(request.url, "http://localhost");
    expect(url.pathname).toBe(operationPath("notes.get"));
    expect([...url.searchParams.keys()]).toEqual(["input"]);
    expect(request.input).toEqual({
      id: "9007199254740993",
      filter: { tags: ["a b", "c&d"] },
    });
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(request.cache).toBe("no-store");
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(request.headers.get("Content-Type")).toBeNull();
  });

  test.each([
    ["notes.create", "POST"],
    ["notes.update", "PATCH"],
    ["notes.replace", "PUT"],
    ["notes.delete", "DELETE"],
  ])("%s sends its declared %s with a JSON body", async (name, method) => {
    const pending = databaseApi.execute(name, { id: 7, total: 10n });
    const request = server.request(0);
    request.respond({ id: 7 });
    await pending;

    expect(request.url).toBe(operationPath(name));
    expect(request.method).toBe(method);
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(request.body).toBe('{"id":7,"total":"10"}');
  });

  test.each([NaN, Infinity, -Infinity])(
    "refuses the non-finite number %s before JSON turns it into null",
    async (value) => {
      for (const name of ["notes.get", "notes.update"]) {
        await expect(
          databaseApi.execute(name, { id: 7, changes: { rank: [value] } }),
        ).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          status: null,
          details: [{ path: ["input"] }],
          message:
            "Database input numbers must be finite; use null explicitly to clear a value",
        });
      }
      expect(server.fetchMock).not.toHaveBeenCalled();
    },
  );

  test("refuses input with no JSON form without echoing it", async () => {
    const cyclic: Record<string, unknown> = { secret: "sentinel-value" };
    cyclic.self = cyclic;
    const throwing = {
      toJSON() {
        throw new Error("sentinel-value");
      },
    };

    for (const input of [undefined, cyclic, throwing, () => 1]) {
      const error = await rejection(databaseApi.execute("notes.create", input));
      expect(error).toMatchObject({ code: "INVALID_REQUEST", status: null });
      expect(JSON.stringify(error)).not.toContain("sentinel-value");
      expect((error as Error).message).not.toContain("sentinel-value");
    }
    expect(server.fetchMock).not.toHaveBeenCalled();
  });
});

describe("decoding replies", () => {
  test("a 204 resolves undefined without reading a body", async () => {
    const response = reply(undefined, { status: 204 });
    const pending = databaseApi.execute("notes.delete", { id: 7 });
    server.request(0).respondWith(response);

    await expect(pending).resolves.toBeUndefined();
    expect(response.bodyUsed).toBe(false);
  });

  test("an explicit JSON answer, null included, is the result", async () => {
    const deleted = databaseApi.execute("notes.delete", { id: 7 });
    server.request(0).respond({ deleted: 1 });
    await expect(deleted).resolves.toEqual({ deleted: 1 });

    const missing = databaseApi.execute("notes.get", { id: 8 });
    server.request(1).respond(null);
    await expect(missing).resolves.toBeNull();
  });

  test.each([
    [400, "INVALID_REQUEST"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [413, "PAYLOAD_TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
    [422, "VALIDATION_FAILED"],
    [503, "TRANSIENT"],
    [500, "INTERNAL"],
    [502, "INTERNAL"],
  ])("maps status %i to %s", async (status, code) => {
    const pending = databaseApi.execute("notes.get", { id: 7 });
    server.request(0).respond({ error: "Stable message" }, { status });

    await expect(pending).rejects.toMatchObject({
      name: "DatabaseApiError",
      code,
      status,
      message: "Stable message",
    });
  });

  test("keeps only bounded details shaped like the server's", async () => {
    const pending = databaseApi.execute("notes.create", { body: "x" });
    server.request(0).respond(
      {
        error: "Database request failed validation",
        details: [
          { path: ["body"], message: "Must be at most 5000 characters" },
          { path: "body", message: "not a detail" },
          { path: [1], message: "not a field name" },
          { message: "no path" },
          { path: ["body"], message: "x".repeat(501) },
          ...Array.from({ length: 30 }, (_, index) => ({
            path: [`field${index}`],
            message: "Required",
          })),
        ],
      },
      { status: 422 },
    );

    const error = (await rejection(pending)) as DatabaseApiError;
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details[0]).toEqual({
      path: ["body"],
      message: "Must be at most 5000 characters",
    });
    // Only the first 20 entries are read, and the malformed ones dropped.
    expect(error.details).toHaveLength(16);
  });

  test.each([
    ["is not JSON", new Response("<html>Bad gateway</html>", { status: 502 })],
    [
      "has an oversized message",
      reply({ error: "x".repeat(501) }, { status: 500 }),
    ],
    [
      "exceeds the error body limit",
      reply(
        { error: "Stable", padding: "x".repeat(70 * 1024) },
        { status: 500 },
      ),
    ],
  ])("keeps the category when the failure body %s", async (_case, response) => {
    const pending = databaseApi.execute("notes.get", { id: 7 });
    server.request(0).respondWith(response);

    await expect(pending).rejects.toMatchObject({
      code: "INTERNAL",
      message: `Database request failed with status ${response.status}`,
      details: [],
    });
  });

  test.each([
    ["notes.get", "INTERNAL", "Database response is not JSON"],
    [
      "notes.create",
      "OUTCOME_UNKNOWN",
      "Database write may have completed; response is not JSON",
    ],
  ])(
    "%s reports a success body that is not JSON as %s",
    async (name, code, message) => {
      const pending = databaseApi.execute(name, { id: 7 });
      server.request(0).respondWith(
        new Response("<!doctype html>", {
          status: 200,
          headers: { "x-appkit-database-actor": "actor-a" },
        }),
      );

      await expect(pending).rejects.toMatchObject({
        code,
        status: 200,
        message,
      });
    },
  );

  test("refuses a success body larger than the response limit", async () => {
    const declared = databaseApi.execute("notes.get", { id: 7 });
    server
      .request(0)
      .respondWith(
        reply(
          { id: 7 },
          { headers: { "Content-Length": String(17 * 2 ** 20) } },
        ),
      );
    await expect(declared).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Database response is too large",
    });

    const streamed = databaseApi.execute("notes.get", { id: 7 });
    const chunk = new Uint8Array(17 * 2 ** 20).fill(32);
    server.request(1).respondWith(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { "x-appkit-database-actor": "actor-a" } },
      ),
    );
    await expect(streamed).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Database response is too large",
    });
  });

  test.each([
    ["notes.get", "INTERNAL"],
    ["notes.create", "OUTCOME_UNKNOWN"],
  ])(
    "%s never returns a success that does not name its actor",
    async (name, code) => {
      for (const actor of [null, "", "x".repeat(257)]) {
        const index = server.requests.length;
        const pending = databaseApi.execute(name, { id: 7 });
        server
          .request(index)
          .respond({ id: 7, body: "unattributed" }, { actor });
        await expect(pending).rejects.toMatchObject({
          code,
          message: expect.stringContaining("does not name its actor"),
        });
      }
    },
  );

  test.each([
    [
      "notes.get",
      "TRANSIENT",
      "Database read failed before receiving a response",
    ],
    [
      "notes.create",
      "OUTCOME_UNKNOWN",
      "Database write may have completed; check its result before retrying",
    ],
  ])(
    "%s reports an unanswered request as %s and never retries it",
    async (name, code, message) => {
      const cause = new TypeError("Failed to fetch");
      const pending = databaseApi.execute(name, { id: 7 });
      server.request(0).fail(cause);

      await expect(pending).rejects.toMatchObject({
        code,
        status: null,
        message,
        cause,
      });
      await flush();
      expect(server.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("a write the server answered after it ran rejects with OUTCOME_UNKNOWN", async () => {
    const unknown = {
      error: "Database write may have completed",
      outcome: "unknown",
    };
    const write = databaseApi.execute("notes.create", { body: "x" });
    server.request(0).respond(unknown, { status: 500 });
    const read = databaseApi.execute("notes.get", { id: 1 });
    server.request(1).respond(unknown, { status: 500 });

    await expect(write).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      status: 500,
    });
    // A read changes nothing, so the same envelope stays a plain failure.
    await expect(read).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  test("a failed write is never sent again", async () => {
    const pending = databaseApi.execute("notes.create", { body: "x" });
    server.request(0).respond({ error: "Unavailable" }, { status: 503 });

    await expect(pending).rejects.toMatchObject({ code: "TRANSIENT" });
    await flush();
    expect(server.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("passes the caller's signal and rejects with its abort, not a database error", async () => {
    const controller = new AbortController();
    const pending = databaseApi.execute(
      "notes.get",
      { id: 7 },
      { signal: controller.signal },
    );
    const request = server.request(0);
    expect(request.signal).toBe(controller.signal);

    controller.abort();
    // The transport ignored the abort; its late answer is still not delivered.
    request.respond({ id: 7 });
    const error = await rejection(pending);

    expect(error).not.toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});

describe("session isolation", () => {
  /** Settle the session on `actor` with one answered read. */
  async function signIn(actor: string): Promise<void> {
    const index = server.requests.length;
    const pending = databaseApi.execute("notes.get", { id: 0 });
    server.request(index).respond({ id: 0 }, { actor });
    await pending;
  }

  test("a late reply for the previous actor is refused once a later reply names another", async () => {
    await signIn("actor-a");
    const older = databaseApi.execute("notes.get", { id: 1 });
    const newer = databaseApi.execute("notes.get", { id: 2 });

    server.request(2).respond({ id: 2, owner: "b" }, { actor: "actor-b" });
    await expect(newer).resolves.toEqual({ id: 2, owner: "b" });

    server.request(1).respond({ id: 1, owner: "a" }, { actor: "actor-a" });
    await expect(older).rejects.toMatchObject({
      code: "SESSION_CHANGED",
      status: null,
      message: "The session changed before the read answered",
    });

    // The session stays with the later actor: no flip back.
    const next = databaseApi.execute("notes.get", { id: 3 });
    server.request(3).respond({ id: 3 }, { actor: "actor-b" });
    await expect(next).resolves.toEqual({ id: 3 });
  });

  test("replies to requests sent before a change was seen cannot flip it back", async () => {
    await signIn("actor-a");
    const revealing = databaseApi.execute("notes.get", { id: 1 });
    const sentLater = databaseApi.execute("notes.get", { id: 2 });

    server.request(1).respond({ id: 1 }, { actor: "actor-b" });
    await expect(revealing).resolves.toEqual({ id: 1 });
    // Sent after the revealing request, but before its reply was seen.
    server.request(2).respond({ id: 2 }, { actor: "actor-a" });
    await expect(sentLater).rejects.toMatchObject({ code: "SESSION_CHANGED" });

    const next = databaseApi.execute("notes.get", { id: 3 });
    server.request(3).respond({ id: 3 }, { actor: "actor-b" });
    await expect(next).resolves.toEqual({ id: 3 });
  });

  test("an earlier-sent reply cannot flip the first actor seen back", async () => {
    const first = databaseApi.execute("notes.get", { id: 1 });
    const second = databaseApi.execute("notes.get", { id: 2 });
    const third = databaseApi.execute("notes.get", { id: 3 });

    server.request(1).respond({ id: 2 }, { actor: "actor-b" });
    await expect(second).resolves.toEqual({ id: 2 });
    server.request(0).respond({ id: 1 }, { actor: "actor-a" });
    await expect(first).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    server.request(2).respond({ id: 3 }, { actor: "actor-b" });
    await expect(third).resolves.toEqual({ id: 3 });
  });

  test("a 401 ends the session, and replies sent before it are refused", async () => {
    await signIn("actor-a");
    const before = databaseApi.execute("notes.get", { id: 1 });
    const write = databaseApi.execute("notes.create", { body: "x" });
    const expired = databaseApi.execute("notes.get", { id: 2 });

    server.request(3).respond({ error: "Sign in again" }, { status: 401 });
    await expect(expired).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    server.request(1).respond({ id: 1 }, { actor: "actor-a" });
    await expect(before).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    server.request(2).respond({ id: 9 }, { actor: "actor-a" });
    await expect(write).rejects.toMatchObject({
      code: "SESSION_CHANGED",
      message:
        "The session changed before the write answered; it may have completed",
    });

    // Signing in again starts the next session from its first reply.
    const after = databaseApi.execute("notes.get", { id: 3 });
    server.request(4).respond({ id: 3 }, { actor: "actor-a" });
    await expect(after).resolves.toEqual({ id: 3 });
  });

  test("a late 401 sent before an authenticated reply does not end the session", async () => {
    const stale = databaseApi.execute("notes.get", { id: 1 });
    const signedIn = databaseApi.execute("notes.get", { id: 2 });
    const inFlight = databaseApi.execute("notes.get", { id: 3 });

    server.request(1).respond({ id: 2 }, { actor: "actor-a" });
    await signedIn;
    server.request(0).respond({ error: "Sign in" }, { status: 401 });
    await expect(stale).rejects.toMatchObject({ code: "SESSION_CHANGED" });

    // Had the 401 opened a new session, this earlier-sent reply would be refused.
    server.request(2).respond({ id: 3 }, { actor: "actor-a" });
    await expect(inFlight).resolves.toEqual({ id: 3 });
  });

  test("a reply without session information is still refused once stale", async () => {
    await signIn("actor-a");
    const proxied = databaseApi.execute("notes.get", { id: 1 });
    const switched = databaseApi.execute("notes.get", { id: 2 });

    server.request(2).respond({ id: 2 }, { actor: "actor-b" });
    await switched;
    server.request(1).respondWith(new Response("Bad gateway", { status: 502 }));
    await expect(proxied).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  });

  test("an authenticated error reply also moves the session", async () => {
    await signIn("actor-a");
    const older = databaseApi.execute("notes.get", { id: 1 });
    const denied = databaseApi.execute("notes.get", { id: 2 });

    server
      .request(2)
      .respond({ error: "Not found" }, { status: 404, actor: "actor-b" });
    await expect(denied).rejects.toMatchObject({ code: "NOT_FOUND" });
    server.request(1).respond({ id: 1 }, { actor: "actor-a" });
    await expect(older).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  });

  test("a session change while a body is still arriving refuses that body", async () => {
    await signIn("actor-a");
    let finish!: () => void;
    const slow = databaseApi.execute("notes.get", { id: 1 });
    server.request(1).respondWith(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":1,'));
            finish = () => {
              controller.enqueue(new TextEncoder().encode('"owner":"a"}'));
              controller.close();
            };
          },
        }),
        { headers: { "x-appkit-database-actor": "actor-a" } },
      ),
    );
    await flush();

    const switched = databaseApi.execute("notes.get", { id: 2 });
    server.request(2).respond({ id: 2 }, { actor: "actor-b" });
    await switched;
    finish();

    await expect(slow).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  });
});

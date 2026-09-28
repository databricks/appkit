import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { _resetConfigCache } from "../config";
import { databaseApi as typedApi, type DatabaseRequestOptions } from "./client";
import { DatabaseApiError } from "./errors";

// This package has no generated registry, so every entity name is `never`
// here. The typed surface is compiled against a real schema in the appkit
// type-generator tests; these cover the runtime transport.
const databaseApi = typedApi as unknown as {
  list(
    entity: string,
    params?: object,
    init?: DatabaseRequestOptions,
  ): Promise<{ items: unknown[]; limit: number; offset: number }>;
  get(
    entity: string,
    id: string | number | bigint,
    params?: object,
    init?: DatabaseRequestOptions,
  ): Promise<Record<string, unknown>>;
  create(
    entity: string,
    values: object,
    init?: DatabaseRequestOptions,
  ): Promise<Record<string, unknown>>;
  update(
    entity: string,
    id: string | number | bigint,
    values: object,
    init?: DatabaseRequestOptions,
  ): Promise<Record<string, unknown>>;
  remove(
    entity: string,
    id: string | number | bigint,
    init?: DatabaseRequestOptions,
  ): Promise<void>;
};

const PAGE = { items: [{ id: 1, body: "hi" }], limit: 5, offset: 0 };

function publish(database: Record<string, string> | undefined): void {
  window.__appkit__ = {
    appName: "test",
    queries: {},
    endpoints: database ? { database } : {},
    plugins: {},
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

describe("databaseApi.list", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => json(PAGE));
    vi.stubGlobal("fetch", fetchMock);
    publish({
      "notes.list": "/api/database/notes",
      "notes.detail": "/api/database/notes/:id",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__appkit__;
    _resetConfigCache();
  });

  test("refuses an unpublished operation locally without sending a request", async () => {
    const error = await rejection(databaseApi.list("boards"));

    expect(error).toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({
      name: "DatabaseApiError",
      code: "NOT_EXPOSED",
      status: null,
      details: [],
      message: 'Database operation "boards.list" is not exposed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses every operation when the plugin published no routes", async () => {
    _resetConfigCache();
    publish(undefined);

    await expect(databaseApi.list("notes")).rejects.toMatchObject({
      code: "NOT_EXPOSED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("calls the published route with the encoded query", async () => {
    const page = await databaseApi.list("notes", {
      where: { board_id: 7 },
      order: { created_at: "desc" },
      limit: 5,
    });

    expect(page).toEqual(PAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [path, query] = url.split("?");
    expect(path).toBe("/api/database/notes");
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      where: '{"board_id":7}',
      order: '{"created_at":"desc"}',
      limit: "5",
    });
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
  });

  test("sends no query string when there are no params", async () => {
    await databaseApi.list("notes");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/database/notes");
  });

  test("rejects an incomplete filter locally without widening the request", async () => {
    await expect(
      databaseApi.list("notes", { where: { board_id: undefined } }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: null,
      message: "Database query contains an unsupported value",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("explains an empty filter locally without broadening the read", async () => {
    await expect(
      databaseApi.list("notes", { where: {} }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: null,
      message: "Filter cannot be empty; omit where to list all rows",
      details: [
        {
          path: ["where"],
          message: "Filter cannot be empty; omit where to list all rows",
        },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([NaN, Infinity, -Infinity])(
    "rejects non-finite filter %s before JSON can turn it into null",
    async (value) => {
      await expect(
        databaseApi.list("notes", { where: { rank: { is: value } } }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        status: null,
        message: "Database query numbers must be finite",
        details: [
          { path: ["where"], message: "Database query numbers must be finite" },
        ],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("uses the route path the server published, not a local convention", async () => {
    _resetConfigCache();
    publish({ "notes.list": "/custom/base/notes" });

    await databaseApi.list("notes", { limit: 1 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/custom/base/notes?limit=1");
  });

  test("decodes a failure envelope into its stable category and details", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: "Invalid database request",
          details: [
            { path: ["where"], message: "Names an unknown column" },
            { path: "where", message: "not a detail" },
            { message: "no path" },
          ],
        },
        400,
      ),
    );

    const error = await rejection(databaseApi.list("notes"));

    expect(error).toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
      message: "Invalid database request",
      details: [{ path: ["where"], message: "Names an unknown column" }],
    });
  });

  test.each([
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [413, "PAYLOAD_TOO_LARGE"],
    [422, "VALIDATION_FAILED"],
    [503, "TRANSIENT"],
    [500, "INTERNAL"],
    [502, "INTERNAL"],
  ])("maps status %i to %s", async (status, code) => {
    fetchMock.mockResolvedValueOnce(json({ error: "stable" }, status));
    await expect(databaseApi.list("notes")).rejects.toMatchObject({
      code,
      status,
    });
  });

  test("keeps the category when a failure body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>Bad gateway</html>", { status: 502 }),
    );

    await expect(databaseApi.list("notes")).rejects.toMatchObject({
      code: "INTERNAL",
      status: 502,
      message: "Database request failed with status 502",
      details: [],
    });
  });

  test("rejects a success body that is not the list envelope", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 1 }]));
    await expect(databaseApi.list("notes")).rejects.toMatchObject({
      code: "INTERNAL",
      status: 200,
    });

    fetchMock.mockResolvedValueOnce(
      new Response("<!doctype html>", { status: 200 }),
    );
    await expect(databaseApi.list("notes")).rejects.toMatchObject({
      code: "INTERNAL",
      status: 200,
      message: "Database response is not JSON",
    });
  });

  test("reports an unanswered read as TRANSIENT without claiming the server never saw it", async () => {
    const cause = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValueOnce(cause);

    const error = await rejection(databaseApi.list("notes"));

    expect(error).toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({ code: "TRANSIENT", status: null, cause });
    expect((error as Error).message).not.toContain("did not reach the server");
  });

  test("passes the caller's signal and rejects with its abort, not a database error", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );

    const pending = databaseApi.list(
      "notes",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    const error = await rejection(pending);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });
    expect(error).not.toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});

describe("databaseApi.get", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => json({ id: 7, title: "Roadmap" }));
    vi.stubGlobal("fetch", fetchMock);
    publish({
      "boards.list": "/api/database/boards",
      "boards.detail": "/api/database/boards/:id",
      "events.list": "/api/database/events",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__appkit__;
    _resetConfigCache();
  });

  test("calls the published detail route with the id and the encoded query", async () => {
    const row = await databaseApi.get("boards", 7, {
      include: { notes: { limit: 20 } },
      select: ["id", "title"],
    });

    expect(row).toEqual({ id: 7, title: "Roadmap" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [path, query] = url.split("?");
    expect(path).toBe("/api/database/boards/7");
    expect([...new URLSearchParams(query)]).toEqual([
      ["select", '["id","title"]'],
      ["include", '{"notes":{"limit":20}}'],
    ]);
    expect(init.method).toBe("GET");
  });

  test("encodes the id as one path segment", async () => {
    await databaseApi.get("boards", "a/b c?d");
    await databaseApi.get("boards", 9007199254740993n);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/database/boards/a%2Fb%20c%3Fd",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/database/boards/9007199254740993",
    );
  });

  test.each(["", ".", ".."])(
    "refuses the id %j, which URL resolution would move off the detail route",
    async (id) => {
      // "" and "." resolve to the list route, ".." to the plugin root.
      const error = await rejection(databaseApi.get("boards", id));

      expect(error).toBeInstanceOf(DatabaseApiError);
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        status: null,
        message: "Database id must be a non-empty path segment",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("keeps an id that only contains dots among other characters", async () => {
    await databaseApi.get("boards", "...");
    await databaseApi.get("boards", "v1.2");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/database/boards/...",
      "/api/database/boards/v1.2",
    ]);
  });

  test("maps a missing row to NOT_FOUND", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: "Database record not found" }, 404),
    );

    await expect(databaseApi.get("boards", 404)).rejects.toMatchObject({
      name: "DatabaseApiError",
      code: "NOT_FOUND",
      status: 404,
      message: "Database record not found",
    });
  });

  test("refuses a keyless table locally, since it has no detail route", async () => {
    const error = await rejection(databaseApi.get("events", 1));

    expect(error).toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({
      code: "NOT_EXPOSED",
      status: null,
      message: 'Database operation "events.detail" is not exposed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects a success body that is not one row", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 7 }]));

    await expect(databaseApi.get("boards", 7)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 200,
      message: "Database response has an unexpected shape",
    });
  });
});

describe("databaseApi writes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => json({ id: 7, body: "hi" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    publish({
      "notes.list": "/api/database/notes",
      "notes.detail": "/api/database/notes/:id",
      "notes.create": "/api/database/notes",
      "notes.update": "/api/database/notes/:id",
      "notes.delete": "/api/database/notes/:id",
      "ledger.create": "/api/database/ledger",
      // Read-only: the plugin published reads but no writes.
      "note_events.list": "/api/database/note_events",
      "note_events.detail": "/api/database/note_events/:id",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__appkit__;
    _resetConfigCache();
  });

  function sent(index = 0): { url: string; init: RequestInit } {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
    return { url, init };
  }

  test("creates with a JSON body on the published route and returns the row", async () => {
    const row = await databaseApi.create("notes", {
      board_id: 7,
      author: "ada",
      body: "hi",
    });

    expect(row).toEqual({ id: 7, body: "hi" });
    const { url, init } = sent();
    expect(url).toBe("/api/database/notes");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      board_id: 7,
      author: "ada",
      body: "hi",
    });
  });

  test("sends a bigint value as its decimal string, which the server reads back exactly", async () => {
    await databaseApi.create("ledger", {
      seq: 9007199254740993n,
      note: "x",
    });

    expect(sent().init.body).toBe('{"seq":"9007199254740993","note":"x"}');
  });

  test.each([NaN, Infinity, -Infinity])(
    "rejects non-finite write %s rather than clearing a nullable value",
    async (value) => {
      for (const write of [
        () => databaseApi.create("notes", { rank: value }),
        () => databaseApi.update("notes", 7, { rank: value }),
        () => databaseApi.update("notes", 7, { payload: { scores: [value] } }),
      ]) {
        await expect(write()).rejects.toMatchObject({
          name: "DatabaseApiError",
          code: "INVALID_REQUEST",
          status: null,
          message:
            "Database write numbers must be finite; use null explicitly to clear a value",
          details: [
            {
              path: ["body"],
              message:
                "Database write numbers must be finite; use null explicitly to clear a value",
            },
          ],
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("keeps an explicit null and finite numbers unchanged", async () => {
    await databaseApi.update("notes", 7, { rank: null, payload: { score: 0 } });
    expect(sent().init.body).toBe('{"rank":null,"payload":{"score":0}}');
  });

  test("sanitizes serialization failures before any write is sent", async () => {
    const values = {
      toJSON: () => {
        throw new Error("private serialization detail");
      },
    };
    await expect(databaseApi.create("notes", values)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: null,
      message: "Database write contains an unsupported value",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reports an unanswered write as unknown because it may have committed", async () => {
    const cause = new TypeError("Connection lost after sending the request");
    fetchMock.mockRejectedValue(cause);

    for (const request of [
      () =>
        databaseApi.create("notes", { board_id: 7, author: "ada", body: "hi" }),
      () => databaseApi.update("notes", 7, { body: "edited" }),
      () => databaseApi.remove("notes", 7),
    ]) {
      await expect(request()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        status: null,
        cause,
        message: expect.stringContaining("may have completed"),
      });
    }
  });

  test("updates one row with PATCH on its encoded id", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 7, body: "edited" }));

    const row = await databaseApi.update("notes", "a/b", { body: "edited" });

    expect(row).toEqual({ id: 7, body: "edited" });
    const { url, init } = sent();
    expect(url).toBe("/api/database/notes/a%2Fb");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(init.body).toBe('{"body":"edited"}');
  });

  test("deletes one row and resolves without reading the empty 204 body", async () => {
    const response = new Response(null, { status: 204 });
    const readBody = vi.spyOn(response, "json");
    fetchMock.mockResolvedValueOnce(response);

    await expect(databaseApi.remove("notes", 7)).resolves.toBeUndefined();

    const { url, init } = sent();
    expect(url).toBe("/api/database/notes/7");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(readBody).not.toHaveBeenCalled();
  });

  test("keeps the server's validation details on a 422", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: "Database request failed validation",
          details: [
            { path: ["body"], message: "Must be at most 5000 characters" },
          ],
        },
        422,
      ),
    );

    const error = await rejection(
      databaseApi.create("notes", { board_id: 7, author: "ada", body: "x" }),
    );

    expect(error).toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      message: "Database request failed validation",
      details: [{ path: ["body"], message: "Must be at most 5000 characters" }],
    });
  });

  test("maps a 415 to UNSUPPORTED_MEDIA_TYPE", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: "Database request body must be JSON" }, 415),
    );

    await expect(
      databaseApi.update("notes", 7, { body: "x" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      message: "Database request body must be JSON",
    });
  });

  test("maps a missing row on update or delete to NOT_FOUND", async () => {
    fetchMock.mockResolvedValue(
      json({ error: "Database record not found" }, 404),
    );

    await expect(
      databaseApi.update("notes", 404, { body: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(databaseApi.remove("notes", 404)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  test("refuses a write addressed by an id that is not one path segment", async () => {
    const results = await Promise.all([
      rejection(databaseApi.update("notes", "..", { body: "x" })),
      rejection(databaseApi.remove("notes", ".")),
      rejection(databaseApi.remove("notes", "")),
    ]);

    expect(results).toMatchObject([
      { code: "INVALID_REQUEST", status: null },
      { code: "INVALID_REQUEST", status: null },
      { code: "INVALID_REQUEST", status: null },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses writes the plugin did not publish without sending a request", async () => {
    const results = await Promise.all([
      rejection(databaseApi.create("note_events", { note_id: 1 })),
      rejection(databaseApi.update("note_events", 1, { action: "x" })),
      rejection(databaseApi.remove("note_events", 1)),
    ]);

    expect(results.map((error) => error instanceof DatabaseApiError)).toEqual([
      true,
      true,
      true,
    ]);
    expect(results).toMatchObject([
      {
        code: "NOT_EXPOSED",
        status: null,
        message: 'Database operation "note_events.create" is not exposed',
      },
      { code: "NOT_EXPOSED", message: expect.stringContaining(".update") },
      { code: "NOT_EXPOSED", message: expect.stringContaining(".delete") },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reports a successful write with an invalid response as outcome unknown", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 7 }], 201));
    await expect(
      databaseApi.create("notes", { board_id: 7, author: "a", body: "b" }),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      status: 201,
      message: expect.stringContaining("may have completed"),
    });

    fetchMock.mockResolvedValueOnce(json({ id: 7 }, 200));
    await expect(databaseApi.remove("notes", 7)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      status: 200,
    });

    fetchMock.mockResolvedValueOnce(
      new Response("broken JSON", { status: 200 }),
    );
    await expect(
      databaseApi.update("notes", 7, { body: "edited" }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 200 });
  });
});

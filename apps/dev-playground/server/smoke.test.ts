import { database } from "@databricks/appkit/beta";
import { createTestApp } from "@databricks/appkit/testing";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { schema } from "../config/database/schema";
import { databaseRoutes } from "./database/routes.gen";
import { lakebaseExamples } from "./lakebase-examples-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";
import {
  type FakeWorkspace,
  fakeWorkspace,
  type MemoryDatabase,
  memoryDatabase,
} from "./testing/database-edges";

// The database plugin opens two external edges at setup: a Lakebase pool and
// the Drizzle data path over it. Both are replaced by the in-memory database
// the running test installs; nothing else in the plugin is faked.
const edges = vi.hoisted(() => ({
  database: undefined as MemoryDatabase | undefined,
}));
vi.mock(
  "../../../packages/appkit/src/connectors/lakebase/index.ts",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    initializeLakebasePool: async () => ({ end: async () => undefined }),
  }),
);
vi.mock(
  "../../../packages/appkit/src/database/runtime/engine/drizzle-data-path.ts",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    createDrizzleDb: () => ({}),
    createDrizzleDataPath: () => {
      if (!edges.database) throw new Error("No in-memory database installed");
      return edges.database.dataPath;
    },
  }),
);

/**
 * Smoke tests for the playground's own server plugins.
 *
 * `tests/` holds Playwright specs that fake `/api` responses at the browser
 * boundary (`page.route` + `fulfill`), so the Express server never runs there.
 * These cover the other side: the plugins boot and answer over real HTTP with
 * the Databricks data plane faked by the harness — no workspace, no
 * credentials, no network.
 */

/**
 * Read one SSE payload, then hang up.
 *
 * `expectStream` buffers a source to completion, and the reconnect stream is
 * five messages three seconds apart — so asserting through it would cost ~12s
 * for a smoke test.
 */
async function firstSSEPayload(res: Response): Promise<unknown> {
  if (!res.body) throw new Error("expected a streaming body, got none");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (!buffered.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    const data = buffered.split("\n").find((line) => line.startsWith("data:"));
    return data ? JSON.parse(data.slice("data:".length).trim()) : undefined;
  } finally {
    await reader.cancel();
  }
}

describe("dev-playground server plugins", () => {
  test("all three boot together and register under their manifest names", async () => {
    await using app = await createTestApp({
      plugins: [reconnect(), telemetryExamples(), lakebaseExamples()],
    });

    expect(app.plugins.reconnect).toBeDefined();
    expect(app.plugins["telemetry-examples"]).toBeDefined();
    expect(app.plugins["lakebase-examples"]).toBeDefined();
  });

  test("GET /api/reconnect answers", async () => {
    await using app = await createTestApp({ plugins: [reconnect()] });

    const res = await app.get("/api/reconnect");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ message: "Reconnected" });
  });

  test("the reconnect stream opens as SSE and emits its first message", async () => {
    await using app = await createTestApp({ plugins: [reconnect()] });

    const res = await app.get("/api/reconnect/stream?sessionId=smoke");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expect(firstSSEPayload(res)).resolves.toMatchObject({
      type: "message",
      count: 1,
      total: 5,
      content: "Message 1 of 5",
    });
  });

  test("POST /api/telemetry-examples/combined threads the userId through every span", async () => {
    // This route really calls `fetch("https://example.com")` (its
    // external-api span). Left alone the suite would need the internet, so
    // non-app requests are stubbed — requests to the app under test must pass
    // through, because that is how the harness reaches its own server. Match on
    // the app's *actual* base URL rather than string-matching localhost, so it
    // stays correct whatever host/port the harness binds (IPv4 or IPv6 `[::1]`).
    const realFetch = globalThis.fetch;
    let appBaseUrl: string | undefined;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return appBaseUrl && url.startsWith(appBaseUrl)
        ? realFetch(input, init)
        : Promise.resolve(new Response("stubbed", { status: 200 }));
    });

    try {
      await using app = await createTestApp({ plugins: [telemetryExamples()] });
      appBaseUrl = app.baseUrl;

      const res = await app.post("/api/telemetry-examples/combined", {
        body: { userId: "smoke-user" },
      });

      expect(res.status).toBe(200);
      // A 200 means the whole nested-span body ran against the real
      // TelemetryProvider: tracer, meter, and logger.
      await expect(res.json()).resolves.toMatchObject({
        success: true,
        result: { userId: "smoke-user" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("lakebase-examples registers its routes when Lakebase is configured", async () => {
    // A bare 404 can't tell "plugin degraded" from a path typo, so assert the
    // route is *present*. injectRoutes gates only on PGHOST/LAKEBASE_ENDPOINT,
    // so with those set the example routes register. setup() still fails fast —
    // a ConfigurationError with no PGUSER, before any pool connect, so no
    // network — and the plugin swallows it, so the app boots regardless.
    await using app = await createTestApp({
      plugins: [lakebaseExamples()],
      env: {
        PGHOST: "test-host.example",
        LAKEBASE_ENDPOINT: "test-endpoint.example",
      },
    });

    expect(app.plugins["lakebase-examples"]).toBeDefined();
    // Present, not 404: the health route answers (503, since the pool never
    // really connected) — proving the route registered, not that a path exists
    // by accident.
    expect(
      (await app.get("/api/lakebase-examples/raw/health")).status,
    ).not.toBe(404);
  });

  test("lakebase-examples registers no routes when Lakebase is unconfigured", async () => {
    // Its setup() and injectRoutes() both bail on missing PGHOST/LAKEBASE_ENDPOINT.
    // The app must still boot; the routes must simply be absent — the same real
    // route that answers above is 404 here, so presence tracks configuration.
    await using app = await createTestApp({
      plugins: [lakebaseExamples()],
      env: { PGHOST: "", LAKEBASE_ENDPOINT: "" },
    });

    expect(app.plugins["lakebase-examples"]).toBeDefined();
    expect((await app.get("/api/lakebase-examples/raw/health")).status).toBe(
      404,
    );
  });
});

describe("dev-playground database operations", () => {
  // Two workspace users, told apart only by the token the Apps proxy forwards.
  const ada = {
    token: "token-ada",
    id: "ada-1001",
    userName: "ada@example.com",
  };
  const bo = { token: "token-bo", id: "bo-2002", userName: "bo@example.com" };
  let workspace: FakeWorkspace;

  beforeAll(async () => {
    workspace = await fakeWorkspace({
      [ada.token]: { id: ada.id, userName: ada.userName },
      [bo.token]: { id: bo.id, userName: bo.userName },
    });
  });
  afterAll(() => workspace.close());

  /** The `id` of a row an operation answered with. */
  async function idOf(response: Response): Promise<number> {
    const row: unknown = await response.json();
    if (
      typeof row !== "object" ||
      row === null ||
      !("id" in row) ||
      typeof row.id !== "number"
    ) {
      throw new Error(`Expected a row with an id, got ${JSON.stringify(row)}`);
    }
    return row.id;
  }

  /** Boot the real plugin with the playground's registry over a fresh database. */
  async function bootDatabase() {
    const memory = memoryDatabase(schema);
    edges.database = memory;
    const app = await createTestApp({
      plugins: [database({ routes: databaseRoutes })],
      env: {
        DATABRICKS_APP_NAME: "playground-smoke",
        DATABRICKS_HOST: workspace.host,
        DATABRICKS_CONFIG_FILE: workspace.configFile,
        // The manifest's Lakebase resource; the faked pool never connects.
        LAKEBASE_ENDPOINT: "projects/smoke/branches/main/endpoints/primary",
        PGHOST: "lakebase.smoke.invalid",
        PGDATABASE: "playground",
        PGPORT: "5432",
        PGSSLMODE: "require",
      },
    });
    const path = (name: string) => `/api/database/operations/${name}`;
    // The Apps proxy forwards the signed-in user's token in this header.
    const as = (token?: string): { headers: Record<string, string> } => ({
      headers: token ? { "x-forwarded-access-token": token } : {},
    });
    return {
      app,
      memory,
      read: (token: string | undefined, name: string, input: unknown) =>
        app.get(
          `${path(name)}?input=${encodeURIComponent(JSON.stringify(input))}`,
          as(token),
        ),
      post: (token: string, name: string, body: unknown) =>
        app.post(path(name), { ...as(token), body }),
      patch: (token: string, name: string, body: unknown) =>
        app.patch(path(name), { ...as(token), body }),
      remove: (token: string, name: string, body: unknown) =>
        app.delete(path(name), { ...as(token), body }),
    };
  }

  test("answers a signed-in caller and refuses an anonymous one", async () => {
    const { app, read } = await bootDatabase();
    await using _app = app;

    expect((await read(undefined, "boards.list", {})).status).toBe(401);
    const signedIn = await read(ada.token, "boards.list", {});
    expect(signedIn.status).toBe(200);
    await expect(signedIn.json()).resolves.toEqual([]);
  });

  test("writes a note and its created event together, authored by the caller", async () => {
    const { app, memory, read, post } = await bootDatabase();
    await using _app = app;
    const boardId = await idOf(
      await post(ada.token, "boards.create", { title: "Launch review" }),
    );

    const created = await post(ada.token, "notes.create", {
      board_id: boardId,
      body: "Ship it",
    });

    expect(created.status).toBe(201);
    const note: unknown = await created.json();
    expect(note).toMatchObject({ author: ada.id, body: "Ship it" });
    expect(note).not.toHaveProperty("author_email");
    const [stored] = memory.rows("notes");
    expect(stored).toMatchObject({
      author: ada.id,
      author_email: ada.userName,
    });
    expect(memory.rows("note_events")).toEqual([
      expect.objectContaining({ note_id: stored?.id, action: "created" }),
    ]);
    const listed = await read(bo.token, "notes.list", { board_id: boardId });
    await expect(listed.json()).resolves.toEqual([
      expect.objectContaining({
        id: stored?.id,
        note_events: [expect.objectContaining({ action: "created" })],
      }),
    ]);
  });

  test("keeps neither the note nor its event when the event write fails", async () => {
    const { app, memory, post } = await bootDatabase();
    await using _app = app;
    const boardId = await idOf(
      await post(ada.token, "boards.create", { title: "Launch review" }),
    );
    memory.failNextInsert("note_events");

    const failed = await post(ada.token, "notes.create", {
      board_id: boardId,
      body: "Lost",
    });

    expect(failed.status).toBe(500);
    expect(memory.rows("notes")).toEqual([]);
    expect(memory.rows("note_events")).toEqual([]);
  });

  test("lets only a note's author edit or delete it", async () => {
    const { app, memory, post, patch, remove } = await bootDatabase();
    await using _app = app;
    const boardId = await idOf(
      await post(ada.token, "boards.create", { title: "Launch review" }),
    );
    const noteId = await idOf(
      await post(ada.token, "notes.create", {
        board_id: boardId,
        body: "Mine",
      }),
    );

    const edit = { id: noteId, body: "Taken over" };
    expect((await patch(bo.token, "notes.update", edit)).status).toBe(403);
    expect(
      (await remove(bo.token, "notes.delete", { id: noteId })).status,
    ).toBe(403);
    expect(memory.rows("notes")).toEqual([
      expect.objectContaining({ body: "Mine" }),
    ]);
    expect(memory.rows("note_events").map((event) => event.action)).toEqual([
      "created",
    ]);

    const edited = await patch(ada.token, "notes.update", {
      id: noteId,
      body: "Still mine",
    });
    expect(edited.status).toBe(200);
    expect(memory.rows("note_events").map((event) => event.action)).toEqual([
      "created",
      "edited",
    ]);
    expect(
      (await remove(ada.token, "notes.delete", { id: noteId })).status,
    ).toBe(204);
    expect(memory.rows("notes")).toEqual([]);
    expect(memory.rows("note_events")).toEqual([]);
  });
});

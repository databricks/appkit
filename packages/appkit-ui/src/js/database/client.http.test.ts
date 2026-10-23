// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { _resetConfigCache } from "../config";
import { databaseApi as typedApi } from "./client";
import { DATABASE_ACTOR_HEADER, resetDatabaseSession } from "./session";

// Real HTTP against a local stub that follows the operation transport
// contract: one JSON `input` query value for GET, a JSON body for writes, the
// actor header on authenticated replies, 204 for no body, and 401 without a
// session. It is not the plugin's handler, which ships with the runtime.
const databaseApi = typedApi as unknown as {
  execute(
    name: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
};

interface Seen {
  method: string;
  path: string;
  query: string[];
  input: unknown;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

const seen: Seen[] = [];
/** Replies the test releases by hand, keyed by the input's `id`. */
const held = new Map<number, (actor: string) => void>();
let actor: string | null = "actor-a";
let origin = "";

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    const query = [...url.searchParams.keys()];
    const input =
      req.method === "GET"
        ? JSON.parse(url.searchParams.get("input") ?? "null")
        : text
          ? JSON.parse(text)
          : undefined;
    seen.push({
      method: req.method ?? "",
      path: url.pathname,
      query,
      input,
      body: text || undefined,
      headers: req.headers,
    });
    const send = (status: number, body: unknown, as: string | null) => {
      if (as !== null) res.setHeader(DATABASE_ACTOR_HEADER, as);
      res.setHeader("Cache-Control", "no-store");
      if (body === undefined) {
        res.writeHead(status).end();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (actor === null) return send(401, { error: "Sign in" }, null);
    const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (name === "notes.get") {
      const id = (input as { id: number }).id;
      if (id >= 100) {
        held.set(id, (as) => send(200, { id, as }, as));
        return;
      }
      return send(200, { id, input }, actor);
    }
    if (name === "notes.huge") {
      res.setHeader(DATABASE_ACTOR_HEADER, actor);
      res.writeHead(200, { "Content-Type": "application/json" });
      const block = Buffer.alloc(1024 * 1024, 32);
      for (let i = 0; i < 17; i += 1) res.write(block);
      return res.end("{}");
    }
    if (name === "notes.create")
      return send(201, { id: 7, ...(input as object) }, actor);
    if (name === "notes.delete") return send(204, undefined, actor);
    return send(404, { error: "Not found" }, actor);
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

function boot(): void {
  const names = ["notes.get", "notes.huge", "notes.create", "notes.delete"];
  const methods: Record<string, string> = {
    "notes.get": "GET",
    "notes.huge": "GET",
    "notes.create": "POST",
    "notes.delete": "DELETE",
  };
  // A browser page at the server's origin, and its fetch, which resolves the
  // published path against the page.
  vi.stubGlobal("window", {
    location: new URL(`${origin}/`),
    __appkit__: {
      appName: "test",
      queries: {},
      endpoints: {
        database: Object.fromEntries(
          names.map((name) => [
            name,
            `/api/database/operations/${encodeURIComponent(name)}`,
          ]),
        ),
      },
      plugins: { database: { operations: methods } },
    },
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
    realFetch(new URL(path, origin), init),
  );
  _resetConfigCache();
  resetDatabaseSession();
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetConfigCache();
  resetDatabaseSession();
  seen.length = 0;
  held.clear();
  actor = "actor-a";
});

describe("databaseApi over HTTP", () => {
  test("a GET input arrives as exactly one JSON query value", async () => {
    boot();
    const input = { id: 1, total: 9007199254740993n, text: "a b&c=d?é" };

    const answer = await databaseApi.execute("notes.get", input);

    expect(answer).toEqual({
      id: 1,
      input: { id: 1, total: "9007199254740993", text: "a b&c=d?é" },
    });
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: "/api/database/operations/notes.get",
      query: ["input"],
      body: undefined,
    });
    expect(seen[0]?.headers.accept).toBe("application/json");
  });

  test("writes send a JSON body, and a 204 resolves undefined", async () => {
    boot();

    await expect(
      databaseApi.execute("notes.create", { body: "hi" }),
    ).resolves.toEqual({ id: 7, body: "hi" });
    await expect(
      databaseApi.execute("notes.delete", { id: 7 }),
    ).resolves.toBeUndefined();

    expect(
      seen.map(({ method, query, input }) => ({ method, query, input })),
    ).toEqual([
      { method: "POST", query: [], input: { body: "hi" } },
      { method: "DELETE", query: [], input: { id: 7 } },
    ]);
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
  });

  test("a late reply for the previous actor is refused", async () => {
    boot();
    await databaseApi.execute("notes.get", { id: 1 });
    const older = databaseApi.execute("notes.get", { id: 100 });
    const newer = databaseApi.execute("notes.get", { id: 101 });
    await vi.waitFor(() => expect(held.size).toBe(2));

    held.get(101)?.("actor-b");
    await expect(newer).resolves.toEqual({ id: 101, as: "actor-b" });
    held.get(100)?.("actor-a");
    await expect(older).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  });

  test("a 401 is UNAUTHENTICATED", async () => {
    boot();
    actor = null;

    await expect(
      databaseApi.execute("notes.get", { id: 1 }),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
      message: "Sign in",
    });
  });

  test("an abort rejects with the abort, not a database error", async () => {
    boot();
    const controller = new AbortController();
    const pending = databaseApi.execute(
      "notes.get",
      { id: 102 },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(held.has(102)).toBe(true));

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a body over the response limit is refused while it streams", async () => {
    boot();

    await expect(databaseApi.execute("notes.huge", {})).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Database response is too large",
    });
  });
});

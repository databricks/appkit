import { describe, expect, test, vi } from "vitest";
import { createDatabaseClient } from "./client";
import { DatabaseHTTPError } from "./errors";

interface UserRow {
  id: number;
  email: string;
  role: "admin" | "member";
}

type UserClient = {
  where: (input: Partial<UserRow>) => UserClient;
  order: (input: Partial<Record<keyof UserRow, "asc" | "desc">>) => UserClient;
  limit: (n: number) => UserClient;
  offset: (n: number) => UserClient;
  include: (input: Record<string, unknown>) => UserClient;
  toArray: (signal?: AbortSignal) => Promise<UserRow[]>;
  first: () => Promise<UserRow | null>;
  find: (id: string | number) => Promise<UserRow | null>;
  count: () => Promise<number>;
  create: (data: Partial<UserRow>) => Promise<UserRow>;
  update: (id: string | number, patch: Partial<UserRow>) => Promise<UserRow>;
  upsert: (
    data: Partial<UserRow>,
    options: { onConflict: string },
  ) => Promise<UserRow>;
  delete: (id: string | number) => Promise<void>;
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup(responses: Response[]) {
  const fetchSpy = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchSpy.mockResolvedValueOnce(response);
  }
  const db = createDatabaseClient({
    baseUrl: "/api/database",
    fetch: fetchSpy,
  });
  return { db, fetchSpy };
}

describe("createDatabaseClient — list + filters", () => {
  test("serializes where + limit into a GET URL", async () => {
    const { db, fetchSpy } = setup([jsonResponse([{ id: 1 }])]);
    const users = db as unknown as { user: UserClient };

    const rows = await users.user.where({ role: "admin" }).limit(10).toArray();

    expect(rows).toEqual([{ id: 1 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user?role=eq.admin&limit=10");
    expect(init?.signal).toBeUndefined();
  });

  test(".include({ posts: true }) emits ?include= without touching select", async () => {
    const { db, fetchSpy } = setup([jsonResponse([])]);
    const users = db as unknown as { user: UserClient };

    await users.user.include({ posts: true }).toArray();

    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toContain("include=posts");
    expect(url).not.toContain("select=");
  });

  test("first() returns the first row or null", async () => {
    const { db, fetchSpy } = setup([jsonResponse([{ id: 7 }])]);
    const users = db as unknown as { user: UserClient };

    const row = await users.user.where({ role: "admin" }).first();
    expect(row).toEqual({ id: 7 });

    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toContain("limit=1");
  });

  test("first() returns null on empty list", async () => {
    const { db } = setup([jsonResponse([])]);
    const users = db as unknown as { user: UserClient };

    expect(await users.user.first()).toBeNull();
  });

  test("passes AbortSignal through to fetch", async () => {
    const { db, fetchSpy } = setup([jsonResponse([])]);
    const users = db as unknown as { user: UserClient };
    const ctrl = new AbortController();

    await users.user.toArray(ctrl.signal);

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.signal).toBe(ctrl.signal);
  });
});

describe("createDatabaseClient — find/count", () => {
  test("find() hits /entity/:id and returns parsed body", async () => {
    const { db, fetchSpy } = setup([jsonResponse({ id: 42, role: "admin" })]);
    const users = db as unknown as { user: UserClient };

    const row = await users.user.find(42);

    expect(row).toEqual({ id: 42, role: "admin" });
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user/42");
  });

  test("find() returns null on 404", async () => {
    const { db } = setup([new Response(null, { status: 404 })]);
    const users = db as unknown as { user: UserClient };

    expect(await users.user.find(999)).toBeNull();
  });

  test("count() reads { count } from /entity/count", async () => {
    const { db, fetchSpy } = setup([jsonResponse({ count: 17 })]);
    const users = db as unknown as { user: UserClient };

    const total = await users.user.where({ role: "admin" }).count();

    expect(total).toBe(17);
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user/count?role=eq.admin");
  });
});

describe("createDatabaseClient — mutations", () => {
  test("create() POSTs JSON body", async () => {
    const { db, fetchSpy } = setup([
      jsonResponse({ id: 1, email: "a@x", role: "member" }, { status: 201 }),
    ]);
    const users = db as unknown as { user: UserClient };

    const created = await users.user.create({ email: "a@x" });
    expect(created).toEqual({ id: 1, email: "a@x", role: "member" });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ email: "a@x" }));
  });

  test("update() PATCHes /entity/:id", async () => {
    const { db, fetchSpy } = setup([jsonResponse({ id: 5, role: "admin" })]);
    const users = db as unknown as { user: UserClient };

    const updated = await users.user.update(5, { role: "admin" });
    expect(updated).toEqual({ id: 5, role: "admin" });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user/5");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ role: "admin" }));
  });

  test("upsert() sends merge-duplicates Prefer header", async () => {
    const { db, fetchSpy } = setup([jsonResponse({ id: 1 })]);
    const users = db as unknown as { user: UserClient };

    await users.user.upsert({ id: 1, email: "a@x" }, { onConflict: "id" });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user?on_conflict=id");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Prefer: "resolution=merge-duplicates",
    });
  });

  test("delete() resolves void on 204", async () => {
    const { db, fetchSpy } = setup([new Response(null, { status: 204 })]);
    const users = db as unknown as { user: UserClient };

    await expect(users.user.delete(3)).resolves.toBeUndefined();

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user/3");
    expect(init?.method).toBe("DELETE");
  });
});

describe("createDatabaseClient — errors", () => {
  test("throws DatabaseHTTPError on non-2xx with parsed body", async () => {
    const { db } = setup([
      new Response(JSON.stringify({ error: "bad input" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const users = db as unknown as { user: UserClient };

    await expect(users.user.create({})).rejects.toMatchObject({
      name: "DatabaseHTTPError",
      status: 400,
      body: { error: "bad input" },
      message: "bad input",
    });
  });

  test("falls back to statusText when body is empty", async () => {
    const { db } = setup([
      new Response(null, { status: 500, statusText: "Server Error" }),
    ]);
    const users = db as unknown as { user: UserClient };

    await expect(users.user.toArray()).rejects.toBeInstanceOf(
      DatabaseHTTPError,
    );
  });

  test("throws on 500 even for delete()", async () => {
    const { db } = setup([new Response(null, { status: 500 })]);
    const users = db as unknown as { user: UserClient };

    await expect(users.user.delete(1)).rejects.toBeInstanceOf(
      DatabaseHTTPError,
    );
  });
});

describe("createDatabaseClient — baseUrl", () => {
  test("strips trailing slash from baseUrl", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse([]));
    const db = createDatabaseClient({
      baseUrl: "/api/database/",
      fetch: fetchSpy,
    });
    const users = db as unknown as { user: UserClient };

    await users.user.toArray();

    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/database/user");
  });

  test("fresh chain per entity access", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse([]));
    const db = createDatabaseClient({ fetch: fetchSpy });
    const typed = db as unknown as { user: UserClient; team: UserClient };

    await typed.user.where({ role: "admin" }).toArray();
    await typed.team.toArray();

    expect(fetchSpy.mock.calls[0]?.[0]).toContain("/api/database/user");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/database/team");
  });
});

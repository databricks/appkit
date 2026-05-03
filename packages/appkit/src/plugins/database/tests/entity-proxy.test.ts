import { describe, expect, test, vi } from "vitest";
import type { DataPath } from "@/database";
import { defineSchema, id, text } from "../../../database";
import { type ExecutorFn, makeEntityClient } from "../entity-proxy";

const schema = defineSchema(({ table }) => ({
  user: table("user", {
    id: id(),
    email: text().notNull(),
    role: text().default("member"),
  }),
}));

function makeExecutor() {
  return vi.fn(async (fn: (signal?: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
  ) as unknown as ExecutorFn & ReturnType<typeof vi.fn>;
}

/**
 * Build a fake `DataPath` whose every method records its call args. Each
 * method returns the supplied fixture row (or rows). This is much smaller
 * than the previous postgrest-builder mock because the surface is flat — no
 * chain to fake.
 */
function fakeDataPath(
  rows: Record<string, unknown>[] = [{ id: 1, email: "a@x" }],
) {
  const calls: Array<{ method: keyof DataPath; args: unknown[] }> = [];
  const path: DataPath = {
    select: vi.fn(async (...args) => {
      calls.push({ method: "select", args });
      return rows;
    }),
    findOne: vi.fn(async (...args) => {
      calls.push({ method: "findOne", args });
      return rows[0] ?? null;
    }),
    count: vi.fn(async (...args) => {
      calls.push({ method: "count", args });
      return rows.length;
    }),
    insert: vi.fn(async (...args) => {
      calls.push({ method: "insert", args });
      return rows[0] ?? { id: 1 };
    }),
    update: vi.fn(async (...args) => {
      calls.push({ method: "update", args });
      return rows[0] ?? { id: 1 };
    }),
    upsert: vi.fn(async (...args) => {
      calls.push({ method: "upsert", args });
      return rows[0] ?? { id: 1 };
    }),
    delete: vi.fn(async (...args) => {
      calls.push({ method: "delete", args });
    }),
    transaction: vi.fn(async (fn) => fn(path)),
    raw: vi.fn(async () => rows as never[]),
  };
  return { path, calls };
}

function makeClient(
  execute = makeExecutor(),
  rows = [{ id: 1, email: "a@x" }],
) {
  const dataPath = fakeDataPath(rows);
  const client = makeEntityClient({
    table: schema.user,
    entity: "user",
    dataPath: dataPath.path,
    execute,
    makeUserDataPath: () => dataPath.path,
    hookContext: () => ({ entity: "user" }),
  });
  return { client, execute, dataPath };
}

describe("EntityClient", () => {
  test("forwards filters/order/pagination/include into DataPath.select", async () => {
    const { client, dataPath } = makeClient();

    await client
      .where({ role: "admin", id: { gte: 1 } })
      .order({ email: "desc" })
      .include({ posts: { select: ["id", "title"], limit: 5 } })
      .limit(10)
      .offset(20)
      .toArray();

    expect(dataPath.path.select).toHaveBeenCalledTimes(1);
    const args = dataPath.calls[0].args[1] as Record<string, unknown>;
    expect(args.where).toEqual({ role: "admin", id: { gte: 1 } });
    expect(args.order).toEqual({ email: "desc" });
    expect(args.limit).toBe(10);
    expect(args.offset).toBe(20);
    expect(args.include).toEqual({
      posts: { select: ["id", "title"], limit: 5 },
    });
  });

  test("every terminator runs through the bound executor", async () => {
    const cases: Array<
      (
        client: ReturnType<typeof makeEntityClient<Record<string, unknown>>>,
      ) => Promise<unknown>
    > = [
      (client) => client.toArray(),
      (client) => client.first(),
      (client) => client.find(1),
      (client) => client.count(),
      (client) => client.create({ email: "a@x" }),
      (client) => client.update(1, { role: "admin" }),
      (client) => client.upsert({ email: "b@x" }, { onConflict: "email" }),
      (client) => client.delete(1),
    ];

    for (const run of cases) {
      const execute = makeExecutor();
      const { client } = makeClient(execute);

      await run(client);

      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  test("create and update hooks can rewrite payloads before validation", async () => {
    const beforeCreate = vi.fn(async (data: Record<string, unknown>) => ({
      ...data,
      role: "admin",
    }));
    const beforeUpdate = vi.fn(
      async (_id: unknown, data: Record<string, unknown>) => ({
        ...data,
        role: "owner",
      }),
    );
    const dataPath = fakeDataPath([{ id: 1, email: "a@x", role: "admin" }]);
    const client = makeEntityClient({
      table: schema.user,
      entity: "user",
      dataPath: dataPath.path,
      execute: makeExecutor(),
      makeUserDataPath: () => dataPath.path,
      hooks: { beforeCreate, beforeUpdate },
      hookContext: () => ({ entity: "user" }),
    });

    await client.create({ email: "a@x" });
    await client.update(1, { email: "b@x" });

    expect(beforeCreate).toHaveBeenCalled();
    expect(beforeUpdate).toHaveBeenCalled();
    expect(dataPath.path.insert).toHaveBeenCalledWith(
      schema.user,
      expect.objectContaining({ role: "admin" }),
      expect.anything(),
    );
    expect(dataPath.path.update).toHaveBeenCalledWith(
      schema.user,
      "id",
      1,
      expect.objectContaining({ role: "owner" }),
      expect.anything(),
    );
  });

  test("asUser builds a fresh user-mode DataPath when the OBO header is present", async () => {
    const serviceDataPath = fakeDataPath([]);
    const userDataPath = fakeDataPath([{ id: 1, email: "u@x" }]);
    const makeUserDataPath = vi.fn(() => userDataPath.path);
    const client = makeEntityClient({
      table: schema.user,
      entity: "user",
      dataPath: serviceDataPath.path,
      execute: makeExecutor(),
      makeUserDataPath,
      hookContext: () => ({ entity: "user" }),
    });
    const req = {
      header: vi.fn((name: string) =>
        name === "x-forwarded-email" ? "user@example.com" : undefined,
      ),
    } as unknown as import("express").Request;

    await client.asUser(req).toArray();

    expect(makeUserDataPath).toHaveBeenCalledWith(req);
    expect(userDataPath.path.select).toHaveBeenCalled();
    expect(serviceDataPath.path.select).not.toHaveBeenCalled();
  });

  test("asUser falls through to self when no per-user DataPath is available", async () => {
    const serviceDataPath = fakeDataPath([{ id: 1, email: "x@x" }]);
    const client = makeEntityClient({
      table: schema.user,
      entity: "user",
      dataPath: serviceDataPath.path,
      execute: makeExecutor(),
      makeUserDataPath: () => null,
      hookContext: () => ({ entity: "user" }),
    });
    const req = {
      header: vi.fn(() => undefined),
    } as unknown as import("express").Request;

    await client.asUser(req).toArray();

    expect(serviceDataPath.path.select).toHaveBeenCalled();
  });
});

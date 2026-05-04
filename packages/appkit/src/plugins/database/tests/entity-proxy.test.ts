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

  test("clamps read limits at the server-side maximum", async () => {
    const { client, dataPath } = makeClient();

    await client.limit(10_000).toArray();

    const args = dataPath.calls[0].args[1] as Record<string, unknown>;
    expect(args.limit).toBe(500);
  });

  test("toArray() applies MAX_LIMIT when no limit is set", async () => {
    const { client, dataPath } = makeClient();

    await client.toArray();

    const args = dataPath.calls[0].args[1] as Record<string, unknown>;
    expect(args.limit).toBe(500);
  });

  test("unbounded() removes the default cap on toArray()", async () => {
    const { client, dataPath } = makeClient();

    await client.unbounded().toArray();

    const args = dataPath.calls[0].args[1] as Record<string, unknown>;
    expect(args.limit).toBeUndefined();
  });

  test("private columns are excluded from default reads and from select()", async () => {
    const sensitive = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
        passwordHash: text().notNull().private(),
      }),
    }));
    const dataPath = fakeDataPath([
      { id: 1, email: "a@x", passwordHash: "secret" },
    ]);
    const client = makeEntityClient({
      table: sensitive.user,
      entity: "user",
      dataPath: dataPath.path,
      execute: makeExecutor(),
      makeUserDataPath: () => dataPath.path,
      hookContext: () => ({ entity: "user" }),
    });

    await client.toArray();
    const defaultArgs = dataPath.calls[0].args[1] as Record<string, unknown>;
    expect(defaultArgs.columns).toEqual(["id", "email"]);

    dataPath.calls.length = 0;
    await client
      .select("id" as never, "email" as never, "passwordHash" as never)
      .toArray();
    const selectedArgs = dataPath.calls[0].args[1] as Record<string, unknown>;
    expect(selectedArgs.columns).toEqual(["id", "email"]);
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

  test("afterCreate, afterUpdate, before/afterDelete are awaited and passed the row", async () => {
    const afterCreate = vi.fn(async () => undefined);
    const afterUpdate = vi.fn(async () => undefined);
    const beforeDelete = vi.fn(async () => undefined);
    const afterDelete = vi.fn(async () => undefined);
    const dataPath = fakeDataPath([{ id: 1, email: "a@x", role: "member" }]);
    const client = makeEntityClient({
      table: schema.user,
      entity: "user",
      dataPath: dataPath.path,
      execute: makeExecutor(),
      makeUserDataPath: () => dataPath.path,
      hooks: { afterCreate, afterUpdate, beforeDelete, afterDelete },
      hookContext: () => ({ entity: "user" }),
    });

    await client.create({ email: "a@x" });
    await client.update(1, { email: "b@x" });
    await client.delete(1);

    expect(afterCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, email: "a@x" }),
      { entity: "user" },
    );
    expect(afterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      { entity: "user" },
    );
    expect(beforeDelete).toHaveBeenCalledWith(1, { entity: "user" });
    expect(afterDelete).toHaveBeenCalledWith(1, { entity: "user" });
  });

  test("upsert does NOT invoke beforeCreate/beforeUpdate (separate channel)", async () => {
    const beforeCreate = vi.fn(async () => undefined);
    const beforeUpdate = vi.fn(async () => undefined);
    const beforeUpsert = vi.fn(async () => undefined);
    const dataPath = fakeDataPath([{ id: 1, email: "a@x", role: "admin" }]);
    const client = makeEntityClient({
      table: schema.user,
      entity: "user",
      dataPath: dataPath.path,
      execute: makeExecutor(),
      makeUserDataPath: () => dataPath.path,
      hooks: { beforeCreate, beforeUpdate, beforeUpsert },
      hookContext: () => ({ entity: "user" }),
    });

    await client.upsert({ email: "a@x" }, { onConflict: "email" });

    expect(beforeUpsert).toHaveBeenCalled();
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(beforeUpdate).not.toHaveBeenCalled();
  });

  test("upsert hooks can rewrite payloads before validation", async () => {
    const beforeUpsert = vi.fn(async (data: Record<string, unknown>) => ({
      ...data,
      role: "admin",
    }));
    const afterUpsert = vi.fn(async () => undefined);
    const dataPath = fakeDataPath([{ id: 1, email: "a@x", role: "admin" }]);
    const client = makeEntityClient({
      table: schema.user,
      entity: "user",
      dataPath: dataPath.path,
      execute: makeExecutor(),
      makeUserDataPath: () => dataPath.path,
      hooks: { beforeUpsert, afterUpsert },
      hookContext: () => ({ entity: "user" }),
    });

    await client.upsert({ email: "a@x" }, { onConflict: "email" });

    expect(beforeUpsert).toHaveBeenCalled();
    expect(afterUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin" }),
      { entity: "user" },
    );
    expect(dataPath.path.upsert).toHaveBeenCalledWith(
      schema.user,
      expect.objectContaining({ role: "admin" }),
      { onConflict: "email" },
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

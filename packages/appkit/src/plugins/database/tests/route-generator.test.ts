import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
} from "@tools/test-helpers";
import { describe, expect, test, vi } from "vitest";
import { defineSchema, id, text } from "../../../database";
import type { EntityClient } from "../entity-proxy";
import { RouteGenerator } from "../route-generator";

const schema = defineSchema(({ table }) => ({
  user: table("user", {
    id: id(),
    email: text().notNull(),
    role: text().default("member"),
  }),
}));

function makeEntity(rows: unknown[] = []) {
  const entity = {
    where: vi.fn(() => entity),
    order: vi.fn(() => entity),
    limit: vi.fn(() => entity),
    offset: vi.fn(() => entity),
    range: vi.fn(() => entity),
    select: vi.fn(() => entity),
    include: vi.fn(() => entity),
    toArray: vi.fn(async () => rows),
    first: vi.fn(async () => rows[0] ?? null),
    find: vi.fn(async () => rows[0] ?? null),
    count: vi.fn(async () => rows.length),
    create: vi.fn(async (data: unknown) => data),
    update: vi.fn(async (_id: unknown, data: unknown) => data),
    upsert: vi.fn(async (data: unknown) => data),
    delete: vi.fn(async () => undefined),
    asUser: vi.fn(() => entity),
  };

  return entity as unknown as EntityClient & typeof entity;
}

describe("RouteGenerator", () => {
  test("registers six routes per entity with obo access by default", async () => {
    const { router, handlers } = createMockRouter();
    const user = makeEntity([]);
    const getSurface = vi.fn(() => ({ user }));
    new RouteGenerator({
      schema,
      config: {},
      getSurface,
      route: (target, config) =>
        target[config.method](config.path, config.handler),
    }).injectAll(router);

    expect(Object.keys(handlers).sort()).toEqual([
      "DELETE:/user/:id",
      "GET:/user",
      "GET:/user/:id",
      "GET:/user/_columns",
      "GET:/user/count",
      "PATCH:/user/:id",
      "POST:/user",
    ]);

    await handlers["GET:/user"](
      createMockRequest({ query: {} }),
      createMockResponse(),
    );

    expect(getSurface).toHaveBeenCalledWith(expect.anything(), "obo");
    expect(user.limit).toHaveBeenCalledWith(50);
  });

  test("applies filters, select projection, order, limit clamp, and include parsing", async () => {
    const { router, getHandler } = createMockRouter();
    const user = makeEntity([{ id: 1, email: "a@x", role: "admin" }]);
    new RouteGenerator({
      schema,
      config: {},
      getSurface: vi.fn(() => ({ user })),
      route: (target, config) =>
        target[config.method](config.path, config.handler),
    }).injectAll(router);

    const handler = getHandler("GET", "/user");
    const res = createMockResponse();
    await handler(
      createMockRequest({
        query: {
          role: "eq.admin",
          email: 'eq."Doe, Jane"',
          select: "id,email,unknownCol",
          include: "posts(id,title),author",
          order: "email.desc",
          limit: "10000",
          offset: "10",
        },
      }),
      res,
    );

    expect(user.where).toHaveBeenCalledWith({ role: { eq: "admin" } });
    expect(user.where).toHaveBeenCalledWith({ email: { eq: "Doe, Jane" } });
    expect(user.select).toHaveBeenCalledWith("id", "email");
    expect(user.include).toHaveBeenCalledWith({
      posts: { select: ["id", "title"] },
      author: true,
    });
    expect(user.order).toHaveBeenCalledWith({ email: "desc" });
    expect(user.limit).toHaveBeenCalledWith(500);
    expect(user.offset).toHaveBeenCalledWith(10);
    expect(res.json).toHaveBeenCalledWith([
      { id: 1, email: "a@x", role: "admin" },
    ]);
  });

  test("honors disabled verbs and service access overrides", async () => {
    const { router, handlers } = createMockRouter();
    const user = makeEntity([]);
    const getSurface = vi.fn(() => ({ user }));
    new RouteGenerator({
      schema,
      config: {
        http: {
          user: {
            count: false,
            delete: false,
            create: "service",
          },
        },
      },
      getSurface,
      route: (target, config) =>
        target[config.method](config.path, config.handler),
    }).injectAll(router);

    expect(handlers["GET:/user/count"]).toBeUndefined();
    expect(handlers["DELETE:/user/:id"]).toBeUndefined();

    await handlers["POST:/user"](
      createMockRequest({ body: { email: "a@x" } }),
      createMockResponse(),
    );

    expect(getSurface).toHaveBeenCalledWith(expect.anything(), "service");
    expect(user.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: "a@x" }),
    );
  });

  test("GET /<entity>/_columns returns the declared column metadata", async () => {
    const { router, handlers } = createMockRouter();
    new RouteGenerator({
      schema,
      config: {},
      getSurface: vi.fn(() => ({ user: makeEntity() })),
      route: (target, config) =>
        target[config.method](config.path, config.handler),
    }).injectAll(router);

    const res = createMockResponse();
    await handlers["GET:/user/_columns"](createMockRequest({}), res);

    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Array.isArray(payload)).toBe(true);
    // Should include every declared column: id, email, role.
    const names = payload.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["email", "id", "role"]);
    // id() is a server-generated PK; role has a default; email is not null.
    const byName = Object.fromEntries(
      payload.map((c: { name: string }) => [c.name, c]),
    );
    expect(byName.id.primaryKey).toBe(true);
    expect(byName.id.generated).toBe(true);
    expect(byName.email.nullable).toBe(false);
    expect(byName.role.hasDefault).toBe(true);
  });

  test("disabling `list` hides /_columns too", async () => {
    const { router, handlers } = createMockRouter();
    new RouteGenerator({
      schema,
      config: { http: { user: { list: false } } },
      getSurface: vi.fn(() => ({ user: makeEntity() })),
      route: (target, config) =>
        target[config.method](config.path, config.handler),
    }).injectAll(router);

    expect(handlers["GET:/user"]).toBeUndefined();
    expect(handlers["GET:/user/_columns"]).toBeUndefined();
  });


  test("returns zod-formatted validation errors from the entity layer", async () => {
    const { router, handlers } = createMockRouter();
    const user = makeEntity([]);
    user.create.mockImplementation(async () => {
      schema.user.$insertSchema.parse({});
      return {};
    });
    new RouteGenerator({
      schema,
      config: {},
      getSurface: vi.fn(() => ({ user })),
      route: (target, config) =>
        target[config.method](config.path, config.handler),
    }).injectAll(router);

    const res = createMockResponse();
    await handlers["POST:/user"](createMockRequest({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ errors: expect.any(Object) });
    expect(user.create).toHaveBeenCalledWith({});
  });
});

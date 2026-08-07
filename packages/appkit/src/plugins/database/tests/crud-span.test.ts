import type { Span, SpanOptions } from "@opentelemetry/api";
import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { defineSchema, id, text } from "../../../database/schema-builder";
import { DatabaseValidationError } from "../../../errors";
import type { ITelemetry } from "../../../telemetry";

const mocks = vi.hoisted(() => ({ createDatabaseState: vi.fn() }));
vi.mock("../lifecycle", () => ({
  createDatabaseState: mocks.createDatabaseState,
}));

import { DatabasePlugin } from "../database";

const schema = defineSchema((builder) => {
  const users = builder.table("users", {
    id: id(),
    name: text(),
    token: text().private(),
  });
  return { users };
});

interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
}

function fakeTelemetry(spans: RecordedSpan[]): ITelemetry {
  return {
    startActiveSpan: <T>(
      name: string,
      options: SpanOptions,
      run: (span: Span) => Promise<T>,
    ) => {
      const attributes: Record<string, unknown> = { ...options.attributes };
      spans.push({ name, attributes });
      const span = {
        setAttribute: (key: string, value: unknown) => {
          attributes[key] = value;
        },
        end: vi.fn(),
      };
      return run(span as unknown as Span);
    },
  } as unknown as ITelemetry;
}

const rows = [{ id: 1, name: "Ada", token: "secret" }];

function entity(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    where: () => chain,
    order: () => chain,
    select: () => chain,
    include: () => chain,
    limit: () => chain,
    offset: () => chain,
    toArray: async () => rows,
    find: async () => rows[0],
    create: async () => rows[0],
    update: async () => rows[0],
    delete: async () => true,
    ...overrides,
  };
  return chain;
}

async function mount(exports: Record<string, unknown>) {
  const spans: RecordedSpan[] = [];
  mocks.createDatabaseState.mockResolvedValue({
    pool: { end: async () => undefined },
    exports,
    deactivate: vi.fn(),
  });
  const plugin = new DatabasePlugin({ schema, crudRoutes: true });
  (plugin as unknown as { telemetry: ITelemetry }).telemetry =
    fakeTelemetry(spans);
  await plugin.setup();

  const handlers = new Map<string, RequestHandler>();
  const record =
    (method: string) => (path: string, handler: RequestHandler) => {
      handlers.set(`${method} ${path}`, handler);
    };
  plugin.injectRoutes({
    get: record("get"),
    post: record("post"),
    patch: record("patch"),
    delete: record("delete"),
  } as unknown as Parameters<typeof plugin.injectRoutes>[0]);
  return { plugin, spans, handlers };
}

function fakeResponse(): Response {
  const res = {
    headersSent: false,
    status: () => res,
    type: () => res,
    setHeader: () => res,
    send: () => res,
  };
  return res as unknown as Response;
}

async function call(
  handler: RequestHandler | undefined,
  url: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<void> {
  const request = {
    originalUrl: url,
    url,
    params,
    body,
    is: () => true,
  } as unknown as Request;
  await (handler as (req: Request, res: Response) => Promise<void>)(
    request,
    fakeResponse(),
  );
}

let mounted: Awaited<ReturnType<typeof mount>>;
beforeEach(async () => {
  mocks.createDatabaseState.mockReset();
  mounted = await mount({ users: entity() });
});

describe("generated route spans", () => {
  test("record only allowlisted, low-cardinality attributes", async () => {
    await call(
      mounted.handlers.get("get /users"),
      `/users?where=${encodeURIComponent('{"name":"Ada"}')}&limit=5`,
    );
    await call(mounted.handlers.get("get /users/:id"), "/users/1", { id: "1" });
    await call(
      mounted.handlers.get("post /users"),
      "/users",
      {},
      {
        name: "Ada",
      },
    );
    await call(
      mounted.handlers.get("patch /users/:id"),
      "/users/1",
      { id: "1" },
      { name: "Grace" },
    );
    await call(mounted.handlers.get("delete /users/:id"), "/users/1", {
      id: "1",
    });

    expect(
      mounted.spans.map((span) => [
        span.name,
        span.attributes.operation,
        span.attributes["http.route"],
        span.attributes.outcome,
      ]),
    ).toEqual([
      ["database.crud.route", "list", "/api/database/users", "success"],
      ["database.crud.route", "detail", "/api/database/users/:id", "success"],
      ["database.crud.route", "create", "/api/database/users", "success"],
      ["database.crud.route", "update", "/api/database/users/:id", "success"],
      ["database.crud.route", "delete", "/api/database/users/:id", "success"],
    ]);
    expect(
      mounted.spans.every((span) => span.attributes.table_name === "users"),
    ).toBe(true);
  });

  test("classify failures without carrying their cause", async () => {
    const failing = await mount({
      users: entity({
        toArray: async () => {
          throw new Error("select * from users where token = 'secret'");
        },
        find: async () => null,
        create: async () => {
          throw new DatabaseValidationError("rejected", [
            { path: ["name"], message: "must not be empty" },
          ]);
        },
      }),
    });
    await call(failing.handlers.get("get /users"), "/users");
    await call(failing.handlers.get("get /users"), "/users?limit=abc");
    await call(failing.handlers.get("get /users/:id"), "/users/1", { id: "1" });
    await call(failing.handlers.get("post /users"), "/users", {}, { name: "" });

    expect(failing.spans.map((span) => span.attributes.outcome)).toEqual([
      "failed",
      "rejected",
      "not_found",
      "rejected",
    ]);
    const serialized = JSON.stringify(failing.spans);
    expect(serialized).not.toContain("select");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("INTERNAL");
    expect(serialized).not.toContain("Ada");
    expect(serialized).not.toContain("must not be empty");
  });

  test("stop serving rows once the plugin drains", async () => {
    await mounted.plugin.shutdown();
    await call(mounted.handlers.get("get /users"), "/users");
    expect(mounted.spans.at(-1)?.attributes.outcome).toBe("failed");
  });
});

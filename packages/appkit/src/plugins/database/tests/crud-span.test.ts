import type { Span, SpanOptions } from "@opentelemetry/api";
import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { defineSchema, id, text } from "../../../database/schema-builder";
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
  plugin.injectRoutes({
    get: (path: string, handler: RequestHandler) => {
      handlers.set(path, handler);
    },
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
): Promise<void> {
  const request = { originalUrl: url, url, params } as unknown as Request;
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

describe("generated read spans", () => {
  test("record only allowlisted, low-cardinality attributes", async () => {
    await call(
      mounted.handlers.get("/users"),
      `/users?where=${encodeURIComponent('{"name":"Ada"}')}&limit=5`,
    );
    await call(mounted.handlers.get("/users/:id"), "/users/1", { id: "1" });

    expect(mounted.spans).toEqual([
      {
        name: "database.crud.route",
        attributes: {
          table_name: "users",
          operation: "list",
          "http.route": "/api/database/users",
          outcome: "success",
        },
      },
      {
        name: "database.crud.route",
        attributes: {
          table_name: "users",
          operation: "detail",
          "http.route": "/api/database/users/:id",
          outcome: "success",
        },
      },
    ]);
  });

  test("classify failures without carrying their cause", async () => {
    const failing = await mount({
      users: entity({
        toArray: async () => {
          throw new Error("select * from users where token = 'secret'");
        },
        find: async () => null,
      }),
    });
    await call(failing.handlers.get("/users"), "/users");
    await call(failing.handlers.get("/users"), "/users?limit=abc");
    await call(failing.handlers.get("/users/:id"), "/users/1", { id: "1" });

    expect(failing.spans.map((span) => span.attributes.outcome)).toEqual([
      "failed",
      "rejected",
      "not_found",
    ]);
    const serialized = JSON.stringify(failing.spans);
    expect(serialized).not.toContain("select");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("INTERNAL");
    expect(serialized).not.toContain("Ada");
  });

  test("stop serving rows once the plugin drains", async () => {
    await mounted.plugin.shutdown();
    await call(mounted.handlers.get("/users"), "/users");
    expect(mounted.spans.at(-1)?.attributes.outcome).toBe("failed");
  });
});

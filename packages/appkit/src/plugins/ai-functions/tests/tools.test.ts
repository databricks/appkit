import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMockRequest,
  mockServiceContext,
} from "../../../testing/fixtures";

const { mockRequest, serviceDatabricksClient, userDatabricksClient } =
  vi.hoisted(() => {
    const mockRequest = vi.fn();
    return {
      mockRequest,
      serviceDatabricksClient: { apiClient: { request: mockRequest } },
      userDatabricksClient: { apiClient: { request: vi.fn() } },
    };
  });

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    event: () => ({
      setComponent: vi.fn().mockReturnThis(),
      setContext: vi.fn().mockReturnThis(),
      setExecution: vi.fn().mockReturnThis(),
    }),
  }),
}));

vi.mock("../../../app", () => ({
  AppManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../../../plugin/dev-reader", () => ({
  DevFileReader: { getInstance: () => ({}) },
}));

vi.mock("../../../stream", () => ({
  StreamManager: vi.fn().mockImplementation(() => ({ abortAll: vi.fn() })),
}));

vi.mock("../../../telemetry", () => ({
  TelemetryManager: {
    getProvider: () => ({
      startActiveSpan: (
        _name: string,
        _options: unknown,
        fn: (span: Record<string, unknown>) => unknown,
      ) =>
        fn({
          end: vi.fn(),
          recordException: vi.fn(),
          setStatus: vi.fn(),
        }),
    }),
  },
  SpanKind: { CLIENT: 3 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
  normalizeTelemetryOptions: () => ({ traces: false, metrics: false }),
}));

import { createRequestScope } from "../../../context/request-scope";
import { AiFunctionsPlugin } from "../ai-functions";

describe("AiFunctionsPlugin agent tools", () => {
  let serviceContextMock: ReturnType<typeof mockServiceContext>;

  beforeEach(() => {
    mockRequest.mockReset();
    userDatabricksClient.apiClient.request.mockReset();
    mockRequest.mockResolvedValue({
      response: [],
      metadata: { version: "2.1" },
    });
    userDatabricksClient.apiClient.request.mockResolvedValue({
      response: [],
      metadata: { version: "2.1" },
    });
    serviceContextMock = mockServiceContext({
      serviceDatabricksClient,
      userDatabricksClient,
    });
  });

  afterEach(() => {
    serviceContextMock.restore();
    vi.unstubAllEnvs();
  });

  const tasks = {
    routeTicket: {
      function: "classify",
      labels: { billing: "Payments", technical: "Bugs" },
      description: "Route a support ticket",
    },
    invoice: {
      function: "extract",
      schema: { total: { type: "number" }, status: { type: "string" } },
    },
    spam: {
      function: "decide",
      questions: { spam: { type: "noul", instructions: "Spam?" } },
      auth: "on-behalf-of-user",
    },
  } as const;

  it("registers one <task>.invoke tool per task", () => {
    const plugin = new AiFunctionsPlugin({ tasks });
    const tools = plugin.getAgentTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "invoice.invoke",
      "routeTicket.invoke",
      "spam.invoke",
    ]);
  });

  it("uses explicit or generated descriptions", () => {
    const tools = new AiFunctionsPlugin({ tasks }).getAgentTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName["routeTicket.invoke"].description).toBe(
      "Route a support ticket",
    );
    expect(byName["invoice.invoke"].description).toBe(
      "Extract these fields from text: total, status.",
    );
    expect(byName["spam.invoke"].description).toBe(
      "Answer these questions about a situation: spam.",
    );
  });

  it("caps generated extract descriptions at 20 fields", () => {
    const schema = Object.fromEntries(
      Array.from({ length: 22 }, (_, i) => [`f${i}`, { type: "string" }]),
    );
    const [tool] = new AiFunctionsPlugin({
      tasks: { wide: { function: "extract", schema } },
    }).getAgentTools();
    expect(tool.description).toBe(
      `Extract these fields from text: ${Object.keys(schema).slice(0, 20).join(", ")}, ….`,
    );
  });

  it("caps generated classify descriptions at 20 labels", () => {
    const labels = Array.from({ length: 25 }, (_, i) => `l${i}`);
    const [tool] = new AiFunctionsPlugin({
      tasks: { many: { function: "classify", labels } },
    }).getAgentTools();
    expect(tool.description).toBe(
      `Classify text as one of: ${labels.slice(0, 20).join(", ")}, ….`,
    );
  });

  it("sets annotations from the task's auth", () => {
    const byName = Object.fromEntries(
      new AiFunctionsPlugin({ tasks }).getAgentTools().map((t) => [t.name, t]),
    );
    expect(byName["routeTicket.invoke"].annotations).toEqual({
      effect: "read",
      requiresUserContext: false,
    });
    expect(byName["spam.invoke"].annotations).toEqual({
      effect: "read",
      requiresUserContext: true,
    });
  });

  it("uses the service client for a service-principal task inside a user context", async () => {
    const plugin = new AiFunctionsPlugin({ tasks });
    await plugin
      .asUser(createMockRequest({ obo: true }) as never)
      .executeAgentTool("routeTicket.invoke", { content: "refund" });
    expect(mockRequest).toHaveBeenCalled();
    expect(userDatabricksClient.apiClient.request).not.toHaveBeenCalled();
  });

  it("uses the user client for an on-behalf-of-user task", async () => {
    const plugin = new AiFunctionsPlugin({ tasks });
    await plugin
      .asUser(createMockRequest({ obo: true }) as never)
      .executeAgentTool("spam.invoke", { state: "win a prize" });
    expect(userDatabricksClient.apiClient.request).toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  const spanAttributes = (exec: { mock: { calls: unknown[][] } }) =>
    (
      exec.mock.calls[0][1] as {
        default: { telemetryInterceptor?: { attributes?: unknown } };
      }
    ).default.telemetryInterceptor?.attributes;

  it("runs a service-principal task as the user inside an on-behalf-of-user scope", async () => {
    // An on-behalf-of-user agent run (or runAgent with a caller) opens a
    // non-legacy user scope. A service-principal task must not widen it.
    const plugin = new AiFunctionsPlugin({ tasks });
    const exec = vi.spyOn(
      plugin as unknown as { execute: (...args: unknown[]) => unknown },
      "execute",
    );
    await createRequestScope(createMockRequest({ obo: true }) as never).run(
      () =>
        plugin.executeAgentTool("routeTicket.invoke", { content: "refund" }),
    );
    expect(userDatabricksClient.apiClient.request).toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(spanAttributes(exec)).toEqual({
      "ai.function.task": "routeTicket",
      "ai.function.auth": "on-behalf-of-user",
    });
  });

  it("records who triggered a service-principal task that leaves a user scope", async () => {
    const plugin = new AiFunctionsPlugin({ tasks });
    const exec = vi.spyOn(
      plugin as unknown as { execute: (...args: unknown[]) => unknown },
      "execute",
    );
    await plugin
      .asUser(createMockRequest({ obo: true }) as never)
      .executeAgentTool("routeTicket.invoke", { content: "refund" });
    expect(mockRequest).toHaveBeenCalled();
    expect(spanAttributes(exec)).toMatchObject({
      "ai.function.auth": "service-principal",
      "ai.function.actor_id": expect.any(String),
    });
  });

  it("ignores extra tool arguments; the model can't override task fields", async () => {
    await new AiFunctionsPlugin({ tasks }).executeAgentTool(
      "routeTicket.invoke",
      {
        content: "refund",
        labels: ["evil", "override"],
      },
    );
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          labels: { billing: "Payments", technical: "Bugs" },
        }),
      }),
      expect.anything(),
    );
  });

  it("throws the generic message for upstream 400s, without the detail", async () => {
    mockRequest.mockRejectedValue(
      Object.assign(new Error("secret upstream detail"), { statusCode: 400 }),
    );
    await expect(
      new AiFunctionsPlugin({ tasks }).executeAgentTool("routeTicket.invoke", {
        content: "x",
      }),
    ).rejects.toThrow(/^Invalid AI Functions request$/);
  });

  it("tags tool calls with ai.function.task", async () => {
    const plugin = new AiFunctionsPlugin({ tasks });
    const exec = vi.spyOn(
      plugin as unknown as { execute: (...args: unknown[]) => unknown },
      "execute",
    );
    await plugin.executeAgentTool("routeTicket.invoke", { content: "x" });
    expect(
      (
        exec.mock.calls[0][1] as {
          default: { telemetryInterceptor?: { attributes?: unknown } };
        }
      ).default.telemetryInterceptor?.attributes,
    ).toEqual({
      "ai.function.task": "routeTicket",
      "ai.function.auth": "service-principal",
    });
  });

  it("returns the API JSON as the tool result", async () => {
    mockRequest.mockResolvedValue({
      response: [{ value: "billing" }],
      metadata: { version: "2.1" },
    });
    const result = await new AiFunctionsPlugin({ tasks }).executeAgentTool(
      "routeTicket.invoke",
      {
        content: "refund",
      },
    );
    expect(result).toEqual({
      response: [{ value: "billing" }],
      metadata: { version: "2.1" },
    });
  });

  it.each(["constructor", "__proto__", "toString", "missing.invoke"])(
    "rejects unknown tool %s",
    async (name) => {
      await expect(
        new AiFunctionsPlugin({ tasks }).executeAgentTool(name, {}),
      ).rejects.toThrow(`Unknown tool: ${name}`);
    },
  );

  it("filters with toolkit({ only })", () => {
    const entries = new AiFunctionsPlugin({ tasks }).toolkit({
      only: ["routeTicket.invoke"],
    });
    expect(Object.keys(entries)).toEqual(["aiFunctions.routeTicket.invoke"]);
  });

  it("has no tools with no tasks", () => {
    expect(new AiFunctionsPlugin({}).getAgentTools()).toEqual([]);
  });

  it("uses the stored parse, not the live config object", async () => {
    const labels = ["billing", "technical"];
    const plugin = new AiFunctionsPlugin({
      tasks: { routeTicket: { function: "classify", labels } },
    });
    labels.push("mutated-after-construction");
    await plugin.executeAgentTool("routeTicket.invoke", { content: "x" });
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ labels: ["billing", "technical"] }),
      }),
      expect.anything(),
    );
  });
});

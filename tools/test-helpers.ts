import { createHash } from "node:crypto";
import type { Span, SpanOptions } from "@opentelemetry/api";
import type { IAppRouter } from "shared";
import { vi } from "vitest";
import type { ServiceContextState } from "../packages/appkit/src/context/service-context";
import type { UserContext } from "../packages/appkit/src/context/user-context";
import type {
  InstrumentConfig,
  ITelemetry,
} from "../packages/appkit/src/telemetry/types";

/**
 * Creates a mock telemetry provider for testing
 */
export function createMockTelemetry(): ITelemetry {
  const mockSpan: Span = {
    addLink: vi.fn(),
    addLinks: vi.fn(),
    end: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    updateName: vi.fn(),
    addEvent: vi.fn(),
    isRecording: vi.fn().mockReturnValue(false),
    spanContext: vi.fn(),
  };

  return {
    getTracer: vi.fn().mockReturnValue({
      startActiveSpan: vi.fn().mockImplementation((...args: any[]) => {
        const fn = args[args.length - 1];
        if (typeof fn === "function") {
          return fn(mockSpan);
        }
        return undefined;
      }),
    }),
    getMeter: vi.fn().mockReturnValue({
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    }),
    getLogger: vi.fn().mockReturnValue({
      emit: vi.fn(),
    }),
    emit: vi.fn(),
    startActiveSpan: vi
      .fn()
      .mockImplementation(
        async (
          _name: string,
          _options: SpanOptions,
          fn: (span: Span) => Promise<any>,
          _tracerOptions?: InstrumentConfig,
        ) => {
          return await fn(mockSpan);
        },
      ),
    registerInstrumentations: vi.fn(),
  };
}

/**
 * Creates a mock Express router with route handler capturing
 */
export function createMockRouter(): {
  router: IAppRouter;
  handlers: Record<string, any>;
  getHandler: (method: string, path: string) => any;
} {
  const handlers: Record<string, any> = {};

  const mockRouter = {
    get: vi.fn((path: string, handler: any) => {
      handlers[`GET:${path}`] = handler;
    }),
    post: vi.fn((path: string, handler: any) => {
      handlers[`POST:${path}`] = handler;
    }),
    put: vi.fn((path: string, handler: any) => {
      handlers[`PUT:${path}`] = handler;
    }),
    delete: vi.fn((path: string, handler: any) => {
      handlers[`DELETE:${path}`] = handler;
    }),
    patch: vi.fn((path: string, handler: any) => {
      handlers[`PATCH:${path}`] = handler;
    }),
  } as unknown as IAppRouter;

  return {
    router: mockRouter,
    handlers,
    getHandler: (method: string, path: string) =>
      handlers[`${method.toUpperCase()}:${path}`],
  };
}

/**
 * Creates a mock Express request object
 */
export function createMockRequest(overrides: any = {}) {
  const mockWorkspaceClient = {
    statementExecution: {
      executeStatement: vi.fn().mockResolvedValue({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      }),
    },
  };

  const req = {
    params: {},
    query: {},
    body: {},
    headers: {},
    userWorkspaceClient: mockWorkspaceClient,
    serviceWorkspaceClient: mockWorkspaceClient,
    getWarehouseId: vi.fn().mockResolvedValue("test-warehouse-id"),
    getWorkspaceId: vi.fn().mockResolvedValue("test-workspace-id"),
    header: function (name: string) {
      return this.headers[name.toLowerCase()];
    },
    ...overrides,
  };
  return req;
}

/**
 * Creates a mock Express response object
 */
export function createMockResponse() {
  const eventListeners: Record<string, Array<(...args: any[]) => void>> = {};

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
    end: vi.fn(function (this: any) {
      this.writableEnded = true;
      // Trigger 'close' event when end is called
      if (eventListeners.close) {
        for (const handler of eventListeners.close) {
          handler();
        }
      }
      return this;
    }),
    write: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn().mockReturnThis(),
    on: vi.fn(function (
      this: any,
      event: string,
      handler: (...args: any[]) => void,
    ) {
      if (!eventListeners[event]) {
        eventListeners[event] = [];
      }
      eventListeners[event].push(handler);
      return this;
    }),
    writableEnded: false,
  };
  return res;
}

/**
 * Sets up common environment variables for Databricks testing
 */
export function setupDatabricksEnv(overrides: Record<string, string> = {}) {
  process.env.DATABRICKS_HOST = "https://test.databricks.com";
  process.env.DATABRICKS_WAREHOUSE_ID = "test-warehouse-id";
  Object.assign(process.env, overrides);
}

/**
 * Context options for running tests with mocked service/user context
 */
export interface TestContextOptions {
  /** Mock WorkspaceClient for service principal operations */
  serviceDatabricksClient?: any;
  /** Mock WorkspaceClient for user operations */
  userDatabricksClient?: any;
  /** User ID for user context */
  userId?: string;
  /** Service user ID */
  serviceUserId?: string;
  /** Warehouse ID */
  warehouseId?: string;
  /** Workspace ID */
  workspaceId?: string;
}

/**
 * Creates a default mock WorkspaceClient for testing
 */
export function createMockWorkspaceClient() {
  return {
    statementExecution: {
      executeStatement: vi.fn().mockResolvedValue({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      }),
    },
  };
}

/**
 * Creates a mock ServiceContext for testing.
 * Call this in beforeEach to set up the ServiceContext mock.
 */
export function createMockServiceContext(options: TestContextOptions = {}) {
  const mockWorkspaceClient = createMockWorkspaceClient();

  const serviceContext: ServiceContextState = {
    client: (options.serviceDatabricksClient || mockWorkspaceClient) as any,
    serviceUserId: options.serviceUserId || "test-service-user",
    warehouseId: Promise.resolve(options.warehouseId || "test-warehouse-id"),
    workspaceId: Promise.resolve(options.workspaceId || "test-workspace-id"),
  };

  return serviceContext;
}

/**
 * Creates a mock UserContext for testing.
 */
export function createMockUserContext(
  options: TestContextOptions = {},
): UserContext {
  const mockWorkspaceClient = createMockWorkspaceClient();

  return {
    client: (options.userDatabricksClient || mockWorkspaceClient) as any,
    userId: options.userId || "test-user",
    warehouseId: Promise.resolve(options.warehouseId || "test-warehouse-id"),
    workspaceId: Promise.resolve(options.workspaceId || "test-workspace-id"),
    isUserContext: true,
  };
}

/**
 * Mocks the ServiceContext singleton for testing.
 * Should be called in beforeEach.
 *
 * @returns Object with spies that can be used to restore the mocks
 */
export async function mockServiceContext(options: TestContextOptions = {}) {
  const serviceContext = createMockServiceContext(options);

  const contextModule = await import(
    "../packages/appkit/src/context/service-context"
  );

  const getSpy = vi
    .spyOn(contextModule.ServiceContext, "get")
    .mockReturnValue(serviceContext);

  const initSpy = vi
    .spyOn(contextModule.ServiceContext, "initialize")
    .mockResolvedValue(serviceContext);

  const isInitializedSpy = vi
    .spyOn(contextModule.ServiceContext, "isInitialized")
    .mockReturnValue(true);

  // Mock createUserContext to return a test user context
  const createUserContextSpy = vi
    .spyOn(contextModule.ServiceContext, "createUserContext")
    .mockImplementation((_token: string, userId: string, userName?: string) => {
      const mockWorkspaceClient = createMockWorkspaceClient();
      return {
        client: (options.userDatabricksClient || mockWorkspaceClient) as any,
        userId,
        userName,
        warehouseId: serviceContext.warehouseId,
        workspaceId: serviceContext.workspaceId,
        isUserContext: true,
      };
    });

  return {
    serviceContext,
    getSpy,
    initSpy,
    isInitializedSpy,
    createUserContextSpy,
    restore: () => {
      getSpy.mockRestore();
      initSpy.mockRestore();
      isInitializedSpy.mockRestore();
      createUserContextSpy.mockRestore();
    },
  };
}

/**
 * Runs a test function within a mocked service context.
 * This sets up the ServiceContext mock, runs the function, and restores the mock.
 */
export async function runWithRequestContext<T>(
  fn: () => T | Promise<T>,
  context?: TestContextOptions,
): Promise<T> {
  const mocks = await mockServiceContext(context);

  try {
    return await fn();
  } finally {
    mocks.restore();
  }
}

/**
 * Parses an SSE response body and returns one frame's data merged with
 * `{ eventType }`. Handles multi-line `data:` payloads, CRLF, and SSE
 * comments. Pass `eventType` to pick a specific frame; without it, the
 * last frame wins.
 */
export async function parseSSEResponse(
  response: Response,
  options: { eventType?: string } = {},
): Promise<any> {
  const text = (await response.text()).replace(/\r\n?/g, "\n");
  const target = options.eventType;

  let chosenEventType: string | null = null;
  let chosenDataLines: string[] | null = null;
  let lastEventType: string | null = null;
  let lastDataLines: string[] | null = null;

  for (const frame of text.split("\n\n")) {
    let eventType: string | null = null;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event: ")) eventType = line.substring(7).trim();
      else if (line.startsWith("data: ")) dataLines.push(line.substring(6));
    }
    if (dataLines.length === 0) continue;
    lastEventType = eventType;
    lastDataLines = dataLines;
    if (target && eventType === target) {
      chosenEventType = eventType;
      chosenDataLines = dataLines;
    }
  }

  const eventType = target ? chosenEventType : lastEventType;
  const dataLines = target ? chosenDataLines : lastDataLines;

  if (!dataLines || dataLines.length === 0) {
    throw new Error(
      `No ${target ? `${target} ` : ""}data found in SSE response: ${text}`,
    );
  }

  return { eventType, ...JSON.parse(dataLines.join("\n")) };
}

export function createConfigurableMockWorkspaceClient() {
  const executeStatement = vi.fn();
  const getStatement = vi.fn();

  const client = {
    statementExecution: {
      executeStatement,
      getStatement,
    },
  };

  return {
    client,
    mocks: {
      executeStatement,
      getStatement,
    },
  };
}

export function createSuccessfulSQLResponse(
  data: any[][],
  columns: Array<{ name: string; type_name?: string }>,
) {
  return {
    status: { state: "SUCCEEDED" },
    statement_id: `stmt-${Date.now()}`,
    result: {
      data_array: data,
    },
    manifest: {
      schema: {
        columns: columns.map((col) => ({
          name: col.name,
          type_name: col.type_name ?? "STRING",
        })),
      },
    },
  };
}

export function createFailedSQLResponse(errorMessage: string) {
  return {
    status: {
      state: "FAILED",
      error: {
        message: errorMessage,
      },
    },
    statement_id: `stmt-${Date.now()}`,
  };
}

/**
 * In-process stand-in for `TaskManager` that runs the handler directly
 * inside `subscribe()` instead of through the vendored Rust engine.
 * Use for unit tests where the real engine (SQLite WAL, recovery
 * worker, FFI sidecar) is overkill.
 *
 * - `start()` keys runs by an engine-shaped IK
 *   (`sha256(name || canon(input) || userId)`).
 * - `subscribe()` yields every `ctx.emit(name, payload)` as
 *   `custom:<name>` then a single `completed` / `failed` terminal.
 * - `_emitHeartbeat` / `_emitStepCheckpoint` exercise the bridge
 *   filters without booting the engine.
 *
 * Skips real recovery, storage dedup, and IK-cache eviction — for
 * those, run against `createApp(...)`.
 */
export function createStubTaskManager() {
  type TaskDef = {
    name: string;
    execute: (input: unknown, ctx: any) => Promise<unknown>;
    recover?: (input: unknown, ctx: any) => Promise<unknown>;
    autoRecover?: boolean;
  };

  const tasks = new Map<string, TaskDef>();
  const stashedRuns = new Map<
    string,
    {
      name: string;
      input: unknown;
      opts: { userId?: string; context?: unknown };
    }
  >();
  /** Pre-injected events keyed by IK; yielded ahead of handler events. */
  const injectedEvents = new Map<
    string,
    Array<{ event: any; streamSeq: number }>
  >();
  let seq = 0;

  // Mirrors the engine IK shape (sha256 hex; the engine emits base64
  // but tests only need stable equality, not byte-for-byte parity).
  const canonicalize = (value: unknown): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map(canonicalize).join(",")}]`;
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`,
    );
    return `{${parts.join(",")}}`;
  };
  const computeIK = (name: string, input: unknown, userId?: string) => {
    const payload = `${name}|${canonicalize(input)}|${userId ?? ""}`;
    return createHash("sha256").update(payload).digest("hex");
  };

  const stub = {
    task: vi.fn((def: TaskDef) => {
      tasks.set(def.name, def);
    }),

    start: vi.fn(
      async (
        name: string,
        input: unknown,
        opts: { userId?: string; context?: unknown } = {},
      ) => {
        const ik = computeIK(name, input, opts.userId);
        stashedRuns.set(ik, { name, input, opts });
        return { taskId: ik, idempotencyKey: ik };
      },
    ),

    subscribe: vi.fn((ik: string) => {
      const run = stashedRuns.get(ik);
      const def = run ? tasks.get(run.name) : undefined;

      return (async function* () {
        if (!run || !def) return;

        // Pre-injected events first (exercises bridge filters).
        const pre = injectedEvents.get(ik);
        if (pre) {
          for (const e of pre) yield e;
        }

        const events: Array<{ event: any; streamSeq: number }> = [];
        const ctx = {
          taskId: ik,
          idempotencyKey: ik,
          userId: run.opts.userId ?? null,
          attempt: 1,
          previousEvents: [],
          isRecovery: false,
          context: run.opts.context ?? null,
          emit: async (eventType: string, payload?: unknown) => {
            events.push({
              event: {
                id: "",
                taskId: ik,
                idempotencyKey: ik,
                seq: ++seq,
                eventType: `custom:${eventType}`,
                timestampMs: Date.now(),
                payload,
              },
              streamSeq: seq,
            });
          },
          heartbeat: async () => {},
        };

        try {
          const result = await def.execute(run.input, ctx);
          events.push({
            event: {
              id: "",
              taskId: ik,
              idempotencyKey: ik,
              seq: ++seq,
              eventType: "completed",
              timestampMs: Date.now(),
              payload: { result },
            },
            streamSeq: seq,
          });
        } catch (err) {
          events.push({
            event: {
              id: "",
              taskId: ik,
              idempotencyKey: ik,
              seq: ++seq,
              eventType: "failed",
              timestampMs: Date.now(),
              payload: {
                error: err instanceof Error ? err.message : String(err),
              },
            },
            streamSeq: seq,
          });
        }

        for (const e of events) yield e;
      })();
    }),

    stop: vi.fn(async (ik: string) => ({ taskId: ik, idempotencyKey: ik })),
    resume: vi.fn(async () => null),
    reconnect: vi.fn(async () => null),
    simulateCrash: vi.fn(),

    hasTask: vi.fn((name: string) => tasks.has(name)),
    getRegistration: vi.fn((name: string) => {
      const t = tasks.get(name);
      return t
        ? { autoRecover: t.autoRecover ?? true, hasRecover: !!t.recover }
        : undefined;
    }),

    // No-op: tests don't simulate shutdown drainage.
    _registerBridge: vi.fn(() => () => {}),

    /** Queue a `heartbeat` engine event ahead of handler events. */
    _emitHeartbeat: (ik: string) => {
      const list = injectedEvents.get(ik) ?? [];
      list.push({
        event: {
          id: "",
          taskId: ik,
          idempotencyKey: ik,
          seq: ++seq,
          eventType: "heartbeat",
          timestampMs: Date.now(),
          payload: null,
        },
        streamSeq: seq,
      });
      injectedEvents.set(ik, list);
    },

    /** Queue a `custom:step:*` checkpoint event (WAL-only, dropped on the wire). */
    _emitStepCheckpoint: (ik: string, name: string, value?: unknown) => {
      const list = injectedEvents.get(ik) ?? [];
      list.push({
        event: {
          id: "",
          taskId: ik,
          idempotencyKey: ik,
          seq: ++seq,
          eventType: `custom:step:${name}`,
          timestampMs: Date.now(),
          payload: value,
        },
        streamSeq: seq,
      });
      injectedEvents.set(ik, list);
    },

    shutdown: vi.fn(async () => {}),
  };

  return stub;
}

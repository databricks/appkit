import type { HookContext, IDatabaseConfig } from "@databricks/appkit/beta";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { schema } from "../config/database/schema";

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(async (_config: unknown) => undefined),
  runAgent: vi.fn(),
}));
vi.mock("@databricks/appkit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@databricks/appkit")>()),
  createApp: mocks.createApp,
}));
vi.mock("@databricks/appkit/beta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@databricks/appkit/beta")>()),
  runAgent: mocks.runAgent,
}));
// Capture the real bootstrap configuration without starting services or loading ORMs.
vi.mock("./lakebase-examples-plugin", () => ({
  lakebaseExamples: () => ({ name: "lakebaseExamples" }),
}));
vi.mock("./reconnect-plugin", () => ({
  reconnect: () => ({ name: "reconnect" }),
}));
vi.mock("./telemetry-example-plugin", () => ({
  telemetryExamples: () => ({ name: "telemetryExamples" }),
}));

type DatabaseConfig = IDatabaseConfig<typeof schema>;
type Hooks = NonNullable<DatabaseConfig["hooks"]>["notes"];
interface CapturedAppConfig {
  plugins: Array<{ name: string; config: unknown }>;
  onPluginsReady(appkit: unknown): Promise<void>;
}

async function loadApp(endpoint = "test-endpoint"): Promise<CapturedAppConfig> {
  vi.resetModules();
  vi.stubEnv("LAKEBASE_ENDPOINT", endpoint);
  vi.stubEnv("APPKIT_E2E_TEST", "");
  mocks.createApp.mockClear();
  await import("./index");
  const call = mocks.createApp.mock.calls[0];
  if (!call) throw new Error("The playground did not call createApp");
  return call[0] as CapturedAppConfig;
}

function requiredHooks(hooks: Hooks) {
  if (!hooks?.beforeCreate || !hooks.afterCreate || !hooks.serialize) {
    throw new Error("The inline database hooks are missing");
  }
  return {
    beforeCreate: hooks.beforeCreate,
    afterCreate: hooks.afterCreate,
    serialize: hooks.serialize,
  };
}

const values = {
  board_id: 7,
  author: "reviewer",
  body: "Original note text",
};
const context = {
  entity: "notes",
  app: { database: {} },
} as HookContext;
let appConfig: CapturedAppConfig;
let databaseConfig: DatabaseConfig;
let hooks: ReturnType<typeof requiredHooks>;

beforeEach(async () => {
  mocks.runAgent.mockReset();
  appConfig = await loadApp();
  const registration = appConfig.plugins.find(
    (plugin) => plugin.name === "database",
  );
  if (!registration) throw new Error("The database plugin was not registered");
  databaseConfig = registration.config as DatabaseConfig;
  hooks = requiredHooks(databaseConfig.hooks?.notes);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const beforeCreate = () => hooks.beforeCreate(values, context);

describe("inline playground database registration", () => {
  test("enables reads for all tables and HTTP writes only for boards and notes", () => {
    expect(Object.keys(databaseConfig.schema.$tables)).toEqual([
      "boards",
      "notes",
      "note_events",
    ]);
    expect(databaseConfig.api).toEqual({
      writes: { tables: ["boards", "notes"] },
    });
  });

  test("does not register the database when Lakebase is not configured", async () => {
    const app = await loadApp("");
    expect(app.plugins.some((plugin) => plugin.name === "database")).toBe(
      false,
    );
  });

  test("leaves all board and database HTTP routes to the generated API", async () => {
    const get = vi.fn();
    const post = vi.fn();
    await appConfig.onPluginsReady({
      database: {},
      server: {
        extend: (register: (router: unknown) => void) =>
          register({ get, post }),
      },
    });
    const paths = [...get.mock.calls, ...post.mock.calls].map(
      ([path]) => path as string,
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(
      paths.some(
        (path) =>
          path.startsWith("/api/boards") || path.startsWith("/api/database"),
      ),
    ).toBe(false);
  });
});

describe("inline database hooks", () => {
  test("uses non-empty model output without changing the original payload", async () => {
    mocks.runAgent.mockResolvedValue({
      text: "  [redacted] note text  ",
      events: [],
    });
    const result = await beforeCreate();
    expect(result).toEqual({
      ...values,
      body: "[redacted] note text",
      author_email: "reviewer@example.com",
    });
    expect(values.body).toBe("Original note text");
    expect(result).not.toBe(values);
  });

  test.each(["", " ", "\n\t  "])(
    "rejects blank model output %j rather than returning the original body",
    async (text) => {
      mocks.runAgent.mockResolvedValue({ text, events: [] });
      await expect(beforeCreate()).rejects.toThrow(
        "Note redaction returned no text",
      );
      expect(values.body).toBe("Original note text");
    },
  );

  test("propagates model failures so the mutation can roll back", async () => {
    const error = new Error("Model unavailable");
    mocks.runAgent.mockRejectedValue(error);
    await expect(beforeCreate()).rejects.toBe(error);
  });

  test("rejects partial output accompanied by an agent error status", async () => {
    mocks.runAgent.mockResolvedValue({
      text: "Partial output",
      events: [{ type: "status", status: "error", error: "upstream detail" }],
    });
    await expect(beforeCreate()).rejects.toThrow("Note redaction failed");
  });

  test("forwards a 10-second abort signal to the model call", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    mocks.runAgent.mockResolvedValue({ text: "Processed note", events: [] });
    await beforeCreate();
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(mocks.runAgent).toHaveBeenCalledWith(expect.anything(), {
      messages: values.body,
      signal: controller.signal,
    });
  });

  test("propagates a model request cancelled by the timeout signal", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mocks.runAgent.mockImplementation(
      (_agent, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const error = new DOMException("Redaction timed out", "TimeoutError");
    const result = beforeCreate();
    const rejected = expect(result).rejects.toBe(error);
    controller.abort(error);
    await rejected;
  });

  test("rejects accumulated text even if the model resolves after cancellation", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const error = new DOMException("Redaction timed out", "TimeoutError");
    mocks.runAgent.mockImplementation(async () => {
      controller.abort(error);
      return {
        text: "Partial text returned by a cancelled stream",
        events: [],
      };
    });
    await expect(beforeCreate()).rejects.toBe(error);
  });

  test("keeps the audit write on the transaction-bound client", async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 });
    const row = {
      ...values,
      id: 2,
      author_email: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    await hooks.afterCreate(row, {
      entity: "notes",
      app: { database: { note_events: { create } } },
    } as unknown as HookContext);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      note_id: 2,
      action: "created",
    });
  });

  test("preserves list previews and full detail responses", () => {
    const row = { body: "x".repeat(200) };
    expect(
      hooks.serialize(row, { entity: "notes", operation: "list" }),
    ).toEqual({ body: "x".repeat(120) });
    expect(hooks.serialize(row, { entity: "notes", operation: "detail" })).toBe(
      row,
    );
  });
});

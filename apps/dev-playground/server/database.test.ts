import type { IDatabaseConfig } from "@databricks/appkit/beta";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { schema } from "../config/database/schema";

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(async (_config: unknown) => undefined),
}));
vi.mock("@databricks/appkit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@databricks/appkit")>()),
  createApp: mocks.createApp,
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

let appConfig: CapturedAppConfig;
let databaseConfig: DatabaseConfig;

beforeEach(async () => {
  appConfig = await loadApp();
  const registration = appConfig.plugins.find(
    (plugin) => plugin.name === "database",
  );
  if (!registration) throw new Error("The database plugin was not registered");
  databaseConfig = registration.config as DatabaseConfig;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("inline playground database registration", () => {
  test("declares three tables in the conventional schema file", () => {
    expect(Object.keys(schema.$tables)).toEqual([
      "boards",
      "notes",
      "note_events",
    ]);
  });

  test("leaves schema discovery to config/database/schema.ts", () => {
    expect(databaseConfig.schema).toBeUndefined();
  });

  test("enables reads for all tables and HTTP writes only for boards and notes", () => {
    expect(databaseConfig.api).toEqual({
      writes: { tables: ["boards", "notes"] },
    });
  });

  test("does not register a removed lifecycle hooks config", () => {
    expect(databaseConfig).not.toHaveProperty("hooks");
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

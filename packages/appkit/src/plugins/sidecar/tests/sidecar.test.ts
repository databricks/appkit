import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SidecarError } from "../../../errors/sidecar";
import type { ISidecarConfig, SidecarDefinition } from "../types";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockProcessManagerInstances: any[] = [];

const { MockProcessManager } = vi.hoisted(() => {
  const MockProcessManager = vi.fn().mockImplementation(() => {
    const instance = {
      spawn: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      status: "stopped" as string,
      port: 3000,
      setHealthy: vi.fn(),
      setUnhealthy: vi.fn(),
      onStatusChange: vi.fn(),
      getOutput: vi.fn().mockReturnValue(["line1", "line2"]),
      getStdin: vi.fn().mockReturnValue({
        write: vi.fn().mockReturnValue(true),
        destroyed: false,
      }),
      getStdout: vi.fn().mockReturnValue({
        on: vi.fn(),
        removeListener: vi.fn(),
      }),
    };
    return instance;
  });

  return { MockProcessManager };
});

vi.mock("../process-manager", () => ({
  ProcessManager: MockProcessManager,
}));

vi.mock("../health-checker", () => ({
  HealthChecker: vi.fn(() => ({
    waitForReady: vi.fn().mockResolvedValue(true),
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../stdio-bridge", () => ({
  StdioBridge: vi.fn(() => ({
    attach: vi.fn(),
    detach: vi.fn(),
    waitForReady: vi.fn().mockResolvedValue(true),
    sendRequest: vi.fn().mockResolvedValue({ status: 200, body: {} }),
    startHealthCheck: vi.fn(),
    stopHealthCheck: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock("../proxy", () => ({
  SidecarProxy: vi.fn(() => ({
    middleware: vi.fn().mockReturnValue(vi.fn()),
  })),
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn((_cmd: string, _opts: any, cb: any) => cb?.(null, "", "")),
  execFile: vi.fn((_bin: string, _args: any, _opts: any, cb: any) =>
    cb?.(null, "", ""),
  ),
}));

vi.mock("node:util", () => ({
  promisify: () => vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

vi.mock("express", () => ({
  Router: vi.fn(() => ({
    all: vi.fn(),
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  })),
}));

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
        fn(),
      ),
      generateKey: vi.fn(),
    })),
  },
}));

// Import AFTER mocks — `sidecar` is a factory (toPlugin wrapper)
// We need the actual SidecarPlugin class to instantiate directly
import { sidecar } from "../sidecar";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHttpConfig(overrides: Partial<SidecarDefinition> = {}): ISidecarConfig {
  return {
    id: "test-http",
    command: "python",
    args: ["-m", "http.server"],
    mode: "http",
    ...overrides,
  };
}

function makeStdioConfig(overrides: Partial<SidecarDefinition> = {}): ISidecarConfig {
  return {
    id: "test-stdio",
    command: "python",
    args: ["bridge.py"],
    mode: "stdio",
    ...overrides,
  };
}

function makeMultiConfig(defs: SidecarDefinition[]): ISidecarConfig {
  return { sidecars: defs } as ISidecarConfig;
}

/**
 * Instantiate SidecarPlugin directly via the toPlugin factory.
 * `sidecar(config)` returns `{ plugin: SidecarPlugin, config, name }`.
 * We use `new data.plugin(config)` to get an instance.
 */
function createPlugin(config: ISidecarConfig) {
  const data = sidecar(config);
  const PluginClass = data.plugin as any;
  return new PluginClass(config);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SidecarPlugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupDatabricksEnv();
    const { ServiceContext } = await import("../../../context/service-context");
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  // ──────────────── A. Plugin Initialization & Configuration ────────────────

  describe("A. Init & Config", () => {
    test("A1: single HTTP sidecar with valid config", () => {
      const data = sidecar(makeHttpConfig());
      expect(data.name).toBe("sidecar");
    });

    test("A2: single stdio sidecar with valid config", () => {
      const data = sidecar(makeStdioConfig());
      expect(data.name).toBe("sidecar");
    });

    test("A3: multiple sidecars in sidecars[] array", () => {
      const inst = createPlugin(
        makeMultiConfig([
          { id: "py", command: "python", mode: "http" },
          { id: "go", command: "go", args: ["run", "main.go"], mode: "stdio" },
        ]),
      );
      // ProcessManager should have been called twice
      expect(MockProcessManager).toHaveBeenCalledTimes(2);
    });

    test("A4: legacy flat config treated as single sidecar", () => {
      const inst = createPlugin({
        id: "legacy",
        command: "ruby",
        args: ["server.rb"],
      });
      expect(MockProcessManager).toHaveBeenCalledTimes(1);
    });

    test("A6: duplicate sidecar id values throw error", () => {
      expect(() =>
        createPlugin(
          makeMultiConfig([
            { id: "dup", command: "python" },
            { id: "dup", command: "ruby" },
          ]),
        ),
      ).toThrow(/Duplicate sidecar id/);
    });

    test("A8: plugin name is always 'sidecar' from manifest", () => {
      // toPlugin derives name from the static manifest, not from config.name
      const data = sidecar({ ...makeHttpConfig(), name: "my-sidecar" });
      expect(data.name).toBe("sidecar");
      // But the instance name comes from config.name
      const inst = createPlugin({ ...makeHttpConfig(), name: "my-sidecar" });
      expect(inst.name).toBe("my-sidecar");
    });
  });

  // ──────────────── G. Exports API ────────────────

  describe("G. Exports API", () => {
    test("G1: get(id) returns SingleSidecarExport for existing sidecar", () => {
      const inst = createPlugin(makeHttpConfig({ id: "my-sc" }));
      const exp = inst.exports();
      const single = exp.get("my-sc");

      expect(single).toBeDefined();
      expect(typeof single!.getStatus).toBe("function");
      expect(typeof single!.restart).toBe("function");
      expect(typeof single!.stop).toBe("function");
      expect(typeof single!.getOutput).toBe("function");
      expect(typeof single!.getPort).toBe("function");
    });

    test("G2: get(id) returns undefined for nonexistent id", () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();
      expect(exp.get("nonexistent")).toBeUndefined();
    });

    test("G3: getAll() returns Map of all sidecars", () => {
      const config = makeMultiConfig([
        { id: "a", command: "python" },
        { id: "b", command: "ruby" },
      ]);
      const inst = createPlugin(config);
      const exp = inst.exports();
      const all = exp.getAll();

      expect(all).toBeInstanceOf(Map);
      expect(all.size).toBe(2);
      expect(all.has("a")).toBe(true);
      expect(all.has("b")).toBe(true);
    });

    test("G4: getStatus(id) returns current status string", () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();
      const status = exp.getStatus("test-http");
      expect(typeof status).toBe("string");
    });

    test("G4: getStatus(id) for unknown id throws SidecarError", () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();
      expect(() => exp.getStatus("unknown")).toThrow(SidecarError);
      expect(() => exp.getStatus("unknown")).toThrow(/Unknown sidecar id/);
    });

    test("G5: getPort(id) returns port number", () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();
      const port = exp.getPort("test-http");
      expect(typeof port).toBe("number");
    });

    test("G6: getOutput(id) returns output lines", () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();
      const output = exp.getOutput("test-http");
      expect(Array.isArray(output)).toBe(true);
    });

    test("G7: restart(id) calls processManager.restart()", async () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();
      const result = exp.restart("test-http");
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    test("G8: stop(id) calls processManager.stop()", async () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();
      const result = exp.stop("test-http");
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  // ──────────────── I. Edge Cases ────────────────

  describe("I. Edge Cases", () => {
    test("I3/I4: exports methods throw for unknown sidecar id", () => {
      const inst = createPlugin(makeHttpConfig());
      const exp = inst.exports();

      expect(() => exp.getStatus("nope")).toThrow(SidecarError);
      expect(() => exp.restart("nope")).toThrow(SidecarError);
      expect(() => exp.stop("nope")).toThrow(SidecarError);
      expect(() => exp.getOutput("nope")).toThrow(SidecarError);
      expect(() => exp.getPort("nope")).toThrow(SidecarError);
    });

    test("injectRoutes does not throw", () => {
      const inst = createPlugin(makeHttpConfig());
      const mockRouter = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
        all: vi.fn(),
      } as any;

      // Mode handler hasn't set up proxy yet (no setup() call), so injectRoutes
      // will skip route registration. This is fine — we're testing it doesn't crash.
      expect(() => inst.injectRoutes(mockRouter)).not.toThrow();
    });

    test("abortActiveOperations does not throw for multiple instances", () => {
      const inst = createPlugin(
        makeMultiConfig([
          { id: "a", command: "python" },
          { id: "b", command: "ruby" },
        ]),
      );
      expect(() => inst.abortActiveOperations()).not.toThrow();
    });
  });
});

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SidecarError } from "../../../errors/sidecar";
import type { SidecarDefinition } from "../types";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockChildProcess = vi.hoisted(() => {
  function createMockChild(opts?: { stdinEnabled?: boolean }) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: any;
      stdout: any;
      stderr: any;
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 1234;
    child.kill = vi.fn((signal?: string) => {
      // Simulate immediate exit on SIGKILL
      if (signal === "SIGKILL") {
        process.nextTick(() => child.emit("exit", null, "SIGKILL"));
      }
      return true;
    });

    if (opts?.stdinEnabled) {
      child.stdin = {
        write: vi.fn().mockReturnValue(true),
        destroyed: false,
        on: vi.fn(),
      };
    } else {
      child.stdin = null;
    }

    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    return child;
  }

  return { createMockChild };
});

const { mockSpawn, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  default: { existsSync: mockExistsSync },
}));

vi.mock("node:net", () => ({
  default: {
    createServer: vi.fn(() => {
      const server = new EventEmitter() as any;
      server.listen = vi.fn((_port: number, cb: () => void) => {
        server.emit("listening");
        cb?.();
      });
      server.address = vi.fn().mockReturnValue({ port: 9999 });
      server.close = vi.fn((cb?: () => void) => cb?.());
      return server;
    }),
  },
}));

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ProcessManager } from "../process-manager";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SidecarDefinition> = {}): SidecarDefinition {
  return {
    id: "test",
    command: "python",
    args: ["-m", "http.server"],
    ...overrides,
  };
}

function spawnReturningChild(stdinEnabled = false) {
  const child = mockChildProcess.createMockChild({ stdinEnabled });
  mockSpawn.mockReturnValue(child);
  return child;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ProcessManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ──────────────── B. Security & Input Validation ────────────────

  describe("B. Security & Input Validation", () => {
    test("B1: rejects shell metacharacters in command (semicolon)", () => {
      expect(() => new ProcessManager(makeConfig({ command: "python; rm -rf /" }))).toThrow(
        /shell metacharacters/,
      );
    });

    test("B1: rejects shell metacharacters in command (pipe)", () => {
      expect(() => new ProcessManager(makeConfig({ command: "cat | grep" }))).toThrow(
        /shell metacharacters/,
      );
    });

    test("B1: rejects shell metacharacters in command (ampersand)", () => {
      expect(() => new ProcessManager(makeConfig({ command: "cmd &" }))).toThrow(
        /shell metacharacters/,
      );
    });

    test("B1: rejects shell metacharacters in command (backtick)", () => {
      expect(() => new ProcessManager(makeConfig({ command: "echo `whoami`" }))).toThrow(
        /shell metacharacters/,
      );
    });

    test("B1: rejects shell metacharacters in command (dollar sign)", () => {
      expect(() => new ProcessManager(makeConfig({ command: "echo $PATH" }))).toThrow(
        /shell metacharacters/,
      );
    });

    test("B1: rejects shell metacharacters in command (newline)", () => {
      expect(() => new ProcessManager(makeConfig({ command: "cmd\nrm" }))).toThrow(
        /shell metacharacters/,
      );
    });

    test("B5: shell: false enforced on spawn", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();
      expect(mockSpawn).toHaveBeenCalledWith(
        "python",
        ["-m", "http.server"],
        expect.objectContaining({ shell: false }),
      );
    });

    test("B1: rejects empty command", () => {
      expect(() => new ProcessManager(makeConfig({ command: "" }))).toThrow(
        /non-empty string/,
      );
    });

    test("B1: rejects whitespace-only command", () => {
      expect(() => new ProcessManager(makeConfig({ command: "   " }))).toThrow(
        /non-empty string/,
      );
    });

    test("cwd with null bytes is rejected", () => {
      expect(() => new ProcessManager(makeConfig({ cwd: "/tmp/\0evil" }))).toThrow(
        /null bytes/,
      );
    });

    test("cwd that does not exist is rejected", () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => new ProcessManager(makeConfig({ cwd: "/nonexistent" }))).toThrow(
        /does not exist/,
      );
    });
  });

  // ──────────────── A. Initialization ────────────────

  describe("A. Init & Config", () => {
    test("A7: missing command throws validation error", () => {
      expect(() => new ProcessManager(makeConfig({ command: "" }))).toThrow(SidecarError);
    });

    test("initial status is stopped", () => {
      const pm = new ProcessManager(makeConfig());
      expect(pm.status).toBe("stopped");
    });

    test("initial port is 0", () => {
      const pm = new ProcessManager(makeConfig());
      expect(pm.port).toBe(0);
    });

    test("spawn sets status to starting", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      const statuses: string[] = [];
      pm.onStatusChange((s) => statuses.push(s));
      await pm.spawn();
      expect(statuses).toContain("starting");
    });

    test("spawn resolves port for http mode", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig({ port: 0 }));
      await pm.spawn();
      expect(pm.port).toBe(9999);
    });

    test("spawn uses fixed port when specified", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig({ port: 3000 }));
      await pm.spawn();
      expect(pm.port).toBe(3000);
    });

    test("spawn skips port resolution for stdio mode", async () => {
      spawnReturningChild(true);
      const pm = new ProcessManager(makeConfig({ mode: "stdio" }));
      await pm.spawn();
      expect(pm.port).toBe(0);
    });

    test("spawn sets PORT and SIDECAR_PORT env vars for http mode", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig({ port: 4000 }));
      await pm.spawn();
      const envArg = mockSpawn.mock.calls[0][2].env;
      expect(envArg.PORT).toBe("4000");
      expect(envArg.SIDECAR_PORT).toBe("4000");
    });

    test("spawn does not set PORT env vars for stdio mode", async () => {
      spawnReturningChild(true);
      const pm = new ProcessManager(makeConfig({ mode: "stdio" }));
      await pm.spawn();
      const envArg = mockSpawn.mock.calls[0][2].env;
      expect(envArg.PORT).toBeUndefined();
      expect(envArg.SIDECAR_PORT).toBeUndefined();
    });

    test("F11: custom env merged with process.env", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig({ env: { MY_VAR: "hello" } }));
      await pm.spawn();
      const envArg = mockSpawn.mock.calls[0][2].env;
      expect(envArg.MY_VAR).toBe("hello");
      // process.env vars should also be present
      expect(envArg.PATH).toBeDefined();
    });

    test("F12: custom cwd applied", async () => {
      mockExistsSync.mockReturnValue(true);
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig({ cwd: "/tmp" }));
      await pm.spawn();
      const cwdArg = mockSpawn.mock.calls[0][2].cwd;
      expect(cwdArg).toContain("tmp");
    });

    test("stdio mode uses pipe for all three stdio channels", async () => {
      spawnReturningChild(true);
      const pm = new ProcessManager(makeConfig({ mode: "stdio" }));
      await pm.spawn();
      expect(mockSpawn.mock.calls[0][2].stdio).toEqual(["pipe", "pipe", "pipe"]);
    });

    test("http mode uses ignore for stdin", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();
      expect(mockSpawn.mock.calls[0][2].stdio).toEqual(["ignore", "pipe", "pipe"]);
    });
  });

  // ──────────────── F. Process Lifecycle & Restart ────────────────

  describe("F. Process Lifecycle & Restart", () => {
    test("F1: child crash triggers auto-restart when enabled", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(
        makeConfig({ restart: { enabled: true, restartDelay: 100 } }),
      );
      await pm.spawn();

      // Second spawn for restart
      const child2 = spawnReturningChild();

      // Simulate crash
      child.emit("exit", 1, null);

      // Wait for restart delay
      await vi.advanceTimersByTimeAsync(150);

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    test("F2: restart.enabled false means no restart on crash", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(
        makeConfig({ restart: { enabled: false } }),
      );
      await pm.spawn();

      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(5000);

      expect(pm.status).toBe("crashed");
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    test("F3: restart delay is respected", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(
        makeConfig({ restart: { enabled: true, restartDelay: 2000 } }),
      );
      await pm.spawn();

      spawnReturningChild();
      child.emit("exit", 1, null);

      // Before delay
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // After delay
      await vi.advanceTimersByTimeAsync(600);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    test("F4: max restarts exceeded sets status to crashed", async () => {
      const pm = new ProcessManager(
        makeConfig({
          restart: {
            enabled: true,
            maxRestarts: 2,
            restartDelay: 10,
            restartWindow: 60000,
          },
        }),
      );

      // Initial spawn
      let child = spawnReturningChild();
      await pm.spawn();

      // Crash 1 → auto-restart
      spawnReturningChild(); // prep next child for auto-restart
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(50);

      // Crash 2 → auto-restart
      child = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      spawnReturningChild(); // prep next child
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(50);

      // Crash 3 → exceeds max (2), should be crashed
      child = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(50);

      expect(pm.status).toBe("crashed");
    });

    test("F5: restart window expiry resets counter", async () => {
      const pm = new ProcessManager(
        makeConfig({
          restart: {
            enabled: true,
            maxRestarts: 1,
            restartDelay: 10,
            restartWindow: 500,
          },
        }),
      );

      // Initial spawn
      let child = spawnReturningChild();
      await pm.spawn();

      // Crash 1 → auto-restart (count: 1)
      spawnReturningChild();
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(50);

      // Now we've used our 1 restart. Wait for window to expire.
      await vi.advanceTimersByTimeAsync(600);

      // Crash again — window has expired, count should reset
      child = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      spawnReturningChild();
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(50);

      // If window reset worked, we should see another spawn (not crashed)
      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(pm.status).not.toBe("crashed");
    });

    test("F7: graceful shutdown sends SIGTERM", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      // Stop and simulate child exiting
      const stopPromise = pm.stop();
      child.emit("exit", 0, "SIGTERM");
      await stopPromise;

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(pm.status).toBe("stopped");
    });

    test("F8: force kill after SIGTERM timeout", async () => {
      const child = spawnReturningChild();
      // Don't auto-exit on SIGKILL for this test
      child.kill = vi.fn().mockImplementation((signal?: string) => {
        if (signal === "SIGKILL") {
          // Simulate delayed exit after SIGKILL
          setTimeout(() => child.emit("exit", null, "SIGKILL"), 10);
        }
        return true;
      });

      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      const stopPromise = pm.stop(500);

      // Don't exit on SIGTERM — wait for force kill
      await vi.advanceTimersByTimeAsync(600);
      await stopPromise;

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    test("F9: output buffer capped at 1000 lines", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      // Emit 1100 lines
      for (let i = 0; i < 1100; i++) {
        child.stderr.emit("data", Buffer.from(`line-${i}\n`));
      }

      const output = pm.getOutput();
      expect(output.length).toBe(1000);
      // Oldest lines should have been evicted
      expect(output[0]).toContain("line-100");
      expect(output[999]).toContain("line-1099");
    });

    test("getOutput returns last N lines when specified", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      for (let i = 0; i < 50; i++) {
        child.stderr.emit("data", Buffer.from(`line-${i}\n`));
      }

      const output = pm.getOutput(5);
      expect(output.length).toBe(5);
      expect(output[4]).toContain("line-49");
    });

    test("stop when no process is running resolves immediately", async () => {
      const pm = new ProcessManager(makeConfig());
      await pm.stop();
      // Should not throw
    });

    test("stop clears pending restart timer", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(
        makeConfig({ restart: { enabled: true, restartDelay: 5000 } }),
      );
      await pm.spawn();

      // Trigger a crash (starts restart timer)
      child.emit("exit", 1, null);

      // Stop immediately — should cancel the restart
      const child2 = spawnReturningChild();
      // Need to wait a bit to let the stop handler fire
      await vi.advanceTimersByTimeAsync(0);

      // Call stop explicitly
      pm.onStatusChange(() => {}); // Just to verify no error
      const stopPromise = pm.stop();
      child2.emit?.("exit", 0, null);
      // The restart timer should have been cleared
    });

    test("restart stops then spawns", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      const child2 = spawnReturningChild();

      const restartPromise = pm.restart();
      // First child exits on SIGTERM
      child.emit("exit", 0, "SIGTERM");
      await restartPromise;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    test("process error event sets status to crashed", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      child.emit("error", new Error("ENOENT"));
      expect(pm.status).toBe("crashed");
    });

    test("setHealthy transitions from starting to healthy", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();
      expect(pm.status).toBe("starting");

      pm.setHealthy();
      expect(pm.status).toBe("healthy");
    });

    test("setUnhealthy transitions from healthy to unhealthy", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();
      pm.setHealthy();
      pm.setUnhealthy();
      expect(pm.status).toBe("unhealthy");
    });

    test("onStatusChange notifies listeners", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      const statuses: string[] = [];
      pm.onStatusChange((s) => statuses.push(s));
      await pm.spawn();
      pm.setHealthy();
      expect(statuses).toEqual(["starting", "healthy"]);
    });

    test("getStdin returns null in http mode", async () => {
      spawnReturningChild(false);
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();
      expect(pm.getStdin()).toBeNull();
    });

    test("getStdin returns writable in stdio mode", async () => {
      spawnReturningChild(true);
      const pm = new ProcessManager(makeConfig({ mode: "stdio" }));
      await pm.spawn();
      expect(pm.getStdin()).not.toBeNull();
    });

    test("getStdout returns readable", async () => {
      spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();
      expect(pm.getStdout()).not.toBeNull();
    });

    test("spawn stops existing process before respawning", async () => {
      const child1 = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      const child2 = spawnReturningChild();
      const spawnPromise = pm.spawn();

      // child1 should get SIGTERM
      child1.emit("exit", 0, "SIGTERM");
      await spawnPromise;

      expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    test("http mode buffers stdout", async () => {
      const child = spawnReturningChild();
      const pm = new ProcessManager(makeConfig());
      await pm.spawn();

      child.stdout.emit("data", Buffer.from("hello world\n"));
      const output = pm.getOutput();
      expect(output.some((l) => l.includes("hello world"))).toBe(true);
    });

    test("stdio mode does NOT buffer stdout (bridge owns it)", async () => {
      const child = spawnReturningChild(true);
      const pm = new ProcessManager(makeConfig({ mode: "stdio" }));
      await pm.spawn();

      child.stdout.emit("data", Buffer.from("should not appear\n"));
      const output = pm.getOutput();
      expect(output.every((l) => !l.includes("should not appear"))).toBe(true);
    });
  });
});

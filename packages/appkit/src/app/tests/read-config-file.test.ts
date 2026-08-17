import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DevFileReader } from "../index";
import { AppManager } from "../index";

// NOTE: unlike the sibling `app.test.ts`, this spec deliberately does NOT mock
// `node:fs/promises` — `readConfigFile` is exercised against real temp files so
// the not-found-vs-throw distinction is driven by genuine errno codes.

describe("AppManager.readConfigFile", () => {
  let tmpDir: string;
  let appManager: AppManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "appmgr-config-"));
    appManager = new AppManager(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("dir override + getter", () => {
    test("queriesDir getter exposes the overridden directory", () => {
      expect(appManager.queriesDir).toBe(tmpDir);
    });

    test("defaults to <cwd>/config/queries when no override is given", () => {
      const defaultManager = new AppManager();
      expect(defaultManager.queriesDir).toBe(
        path.resolve(process.cwd(), "config/queries"),
      );
    });

    test("metricViewsDir getter exposes the overridden directory", () => {
      const mvDir = path.join(tmpDir, "metric-views");
      const manager = new AppManager(tmpDir, mvDir);
      expect(manager.metricViewsDir).toBe(mvDir);
    });

    test("metricViewsDir defaults to a sibling of queriesDir", () => {
      // Single-arg construction: metric-views sits next to the queries dir.
      const manager = new AppManager(tmpDir);
      expect(manager.metricViewsDir).toBe(
        path.resolve(path.dirname(tmpDir), "metric-views"),
      );
    });

    test("metricViewsDir defaults to <cwd>/config/metric-views with no override", () => {
      const defaultManager = new AppManager();
      expect(defaultManager.metricViewsDir).toBe(
        path.resolve(process.cwd(), "config/metric-views"),
      );
    });
  });

  describe("production mode (direct fs)", () => {
    test("returns file contents for an existing file", async () => {
      await fs.writeFile(
        path.join(tmpDir, "sample-config.json"),
        '{"hello":"world"}',
        "utf8",
      );

      const result = await appManager.readConfigFile("sample-config.json");
      expect(result).toBe('{"hello":"world"}');
    });

    test("returns null for a genuine not-found (ENOENT)", async () => {
      const result = await appManager.readConfigFile("does-not-exist.json");
      expect(result).toBeNull();
    });

    test("throws (does NOT return null) for a non-ENOENT error", async () => {
      // Reading a directory as a file rejects with EISDIR — a real, non-ENOENT
      // error that must propagate rather than be swallowed to null.
      await fs.mkdir(path.join(tmpDir, "a-directory"));

      await expect(appManager.readConfigFile("a-directory")).rejects.toThrow();
    });

    test("throws for a simulated EACCES (permission) error", async () => {
      const err = Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
      vi.spyOn(fs, "readFile").mockRejectedValueOnce(err);

      await expect(
        appManager.readConfigFile("sample-config.json"),
      ).rejects.toThrow("permission denied");
    });

    test("reads via direct fs (not the dev reader) without ?dev", async () => {
      await fs.writeFile(
        path.join(tmpDir, "sample-config.json"),
        "prod-contents",
        "utf8",
      );
      const devFileReader: DevFileReader = {
        readdir: vi.fn(),
        readFile: vi.fn(),
      };

      const result = await appManager.readConfigFile(
        "sample-config.json",
        { query: {}, headers: {} },
        devFileReader,
      );

      expect(result).toBe("prod-contents");
      expect(devFileReader.readFile).not.toHaveBeenCalled();
    });
  });

  describe("path traversal protection", () => {
    test("returns null and does not read outside the queries dir", async () => {
      const readSpy = vi.spyOn(fs, "readFile");
      const result = await appManager.readConfigFile("../../etc/passwd");

      expect(result).toBeNull();
      expect(readSpy).not.toHaveBeenCalled();
    });
  });

  describe("dev mode (WebSocket tunnel)", () => {
    const devReq = { query: { dev: "true" }, headers: {} };

    test("reads via devFileReader in dev mode", async () => {
      const devFileReader: DevFileReader = {
        readdir: vi.fn(),
        readFile: vi.fn().mockResolvedValue("dev-contents"),
      };

      const result = await appManager.readConfigFile(
        "sample-config.json",
        devReq,
        devFileReader,
      );

      expect(result).toBe("dev-contents");
      expect(devFileReader.readFile).toHaveBeenCalledWith(
        expect.stringContaining("sample-config.json"),
        devReq,
      );
    });

    test("returns null for the dev tunnel's not-found signal (best-effort)", async () => {
      const devFileReader: DevFileReader = {
        readdir: vi.fn(),
        readFile: vi
          .fn()
          .mockRejectedValue(new Error("ENOENT: no such file or directory")),
      };

      const result = await appManager.readConfigFile(
        "sample-config.json",
        devReq,
        devFileReader,
      );

      expect(result).toBeNull();
    });

    test("throws for a non-not-found dev tunnel error", async () => {
      const devFileReader: DevFileReader = {
        readdir: vi.fn(),
        readFile: vi.fn().mockRejectedValue(new Error("tunnel disconnected")),
      };

      await expect(
        appManager.readConfigFile("sample-config.json", devReq, devFileReader),
      ).rejects.toThrow("tunnel disconnected");
    });
  });

  describe("readMetricViewsConfig (metric-views dir)", () => {
    let mvDir: string;
    let manager: AppManager;

    beforeEach(async () => {
      // Give the metric-views dir its own explicit path so it is independent of
      // the queries dir under test above.
      mvDir = await fs.mkdtemp(path.join(os.tmpdir(), "appmgr-mv-"));
      manager = new AppManager(tmpDir, mvDir);
    });

    afterEach(async () => {
      await fs.rm(mvDir, { recursive: true, force: true });
    });

    test("reads definitions.json from the metric-views dir", async () => {
      await fs.writeFile(
        path.join(mvDir, "definitions.json"),
        '{"metricViews":{}}',
        "utf8",
      );

      const result = await manager.readMetricViewsConfig("definitions.json");
      expect(result).toBe('{"metricViews":{}}');
    });

    test("does NOT read the file from the queries dir", async () => {
      // A definitions.json in the queries dir must not resolve — the reader is
      // rooted at the metric-views dir only.
      await fs.writeFile(
        path.join(tmpDir, "definitions.json"),
        '{"metricViews":{"stray":{}}}',
        "utf8",
      );

      const result = await manager.readMetricViewsConfig("definitions.json");
      expect(result).toBeNull();
    });

    test("returns null for a genuine not-found (ENOENT)", async () => {
      const result = await manager.readMetricViewsConfig("definitions.json");
      expect(result).toBeNull();
    });

    test("returns null and does not read outside the metric-views dir", async () => {
      const readSpy = vi.spyOn(fs, "readFile");
      const result = await manager.readMetricViewsConfig("../../etc/passwd");

      expect(result).toBeNull();
      expect(readSpy).not.toHaveBeenCalled();
    });

    test("reads via devFileReader in dev mode", async () => {
      const devReq = { query: { dev: "true" }, headers: {} };
      const devFileReader: DevFileReader = {
        readdir: vi.fn(),
        readFile: vi.fn().mockResolvedValue("dev-mv-contents"),
      };

      const result = await manager.readMetricViewsConfig(
        "definitions.json",
        devReq,
        devFileReader,
      );

      expect(result).toBe("dev-mv-contents");
      expect(devFileReader.readFile).toHaveBeenCalledWith(
        expect.stringContaining("definitions.json"),
        devReq,
      );
    });
  });
});

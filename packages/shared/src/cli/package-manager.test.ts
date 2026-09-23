import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectPackageManager, PM_COMMANDS } from "./package-manager";

describe("package-manager", () => {
  const originalEnv = process.env.npm_config_user_agent;

  beforeEach(() => {
    delete process.env.npm_config_user_agent;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.npm_config_user_agent = originalEnv;
    } else {
      delete process.env.npm_config_user_agent;
    }
  });

  describe("detectPackageManager", () => {
    it("detects pnpm from npm_config_user_agent", () => {
      process.env.npm_config_user_agent = "pnpm/8.6.0 npm/? node/18.0.0";
      const cwd = path.join(os.tmpdir(), "test-pnpm");
      expect(detectPackageManager(cwd)).toBe("pnpm");
    });

    it("detects npm from npm_config_user_agent", () => {
      process.env.npm_config_user_agent = "npm/9.8.1 node/18.0.0";
      const cwd = path.join(os.tmpdir(), "test-npm");
      expect(detectPackageManager(cwd)).toBe("npm");
    });

    it("detects yarn from npm_config_user_agent", () => {
      process.env.npm_config_user_agent = "yarn/3.6.0 npm/? node/18.0.0";
      const cwd = path.join(os.tmpdir(), "test-yarn");
      expect(detectPackageManager(cwd)).toBe("yarn");
    });

    it("detects bun from npm_config_user_agent", () => {
      process.env.npm_config_user_agent = "bun/1.0.0 npm/? node/18.0.0";
      const cwd = path.join(os.tmpdir(), "test-bun");
      expect(detectPackageManager(cwd)).toBe("bun");
    });

    it("falls back to lockfile detection when npm_config_user_agent is absent", () => {
      delete process.env.npm_config_user_agent;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
        expect(detectPackageManager(tmpDir)).toBe("pnpm");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("detects yarn from yarn.lock when env var is absent", () => {
      delete process.env.npm_config_user_agent;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
        expect(detectPackageManager(tmpDir)).toBe("yarn");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("detects bun from bun.lockb when env var is absent", () => {
      delete process.env.npm_config_user_agent;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
        expect(detectPackageManager(tmpDir)).toBe("bun");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("detects npm from package-lock.json when env var is absent", () => {
      delete process.env.npm_config_user_agent;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "");
        expect(detectPackageManager(tmpDir)).toBe("npm");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("defaults to pnpm when neither env var nor lockfile is present", () => {
      delete process.env.npm_config_user_agent;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        expect(detectPackageManager(tmpDir)).toBe("pnpm");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("prefers npm_config_user_agent over lockfile", () => {
      process.env.npm_config_user_agent = "npm/9.8.1 node/18.0.0";
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
        expect(detectPackageManager(tmpDir)).toBe("npm");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("prefers npm_config_user_agent over package-lock.json", () => {
      process.env.npm_config_user_agent = "pnpm/8.6.0 npm/? node/18.0.0";
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "");
        expect(detectPackageManager(tmpDir)).toBe("pnpm");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("ignores invalid npm_config_user_agent and falls back to lockfile", () => {
      process.env.npm_config_user_agent = "unknown/1.0.0 node/18.0.0";
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
        expect(detectPackageManager(tmpDir)).toBe("yarn");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("PM_COMMANDS", () => {
    describe("pnpm", () => {
      it("provides correct install command", () => {
        expect(PM_COMMANDS.pnpm.install).toBe("pnpm install");
      });

      it("provides correct build command with run", () => {
        expect(PM_COMMANDS.pnpm.build).toBe("pnpm run build");
      });

      it("provides correct add command", () => {
        expect(PM_COMMANDS.pnpm.add("pkg1 pkg2")).toBe("pnpm add pkg1 pkg2");
      });

      it("provides correct exec command", () => {
        expect(PM_COMMANDS.pnpm.exec).toBe("pnpm exec");
      });
    });

    describe("npm", () => {
      it("provides correct install command", () => {
        expect(PM_COMMANDS.npm.install).toBe("npm install");
      });

      it("provides correct build command with run", () => {
        expect(PM_COMMANDS.npm.build).toBe("npm run build");
      });

      it("provides correct add command (uses install)", () => {
        expect(PM_COMMANDS.npm.add("pkg1 pkg2")).toBe("npm install pkg1 pkg2");
      });

      it("provides correct exec command (npx)", () => {
        expect(PM_COMMANDS.npm.exec).toBe("npx");
      });
    });

    describe("yarn", () => {
      it("provides correct install command", () => {
        expect(PM_COMMANDS.yarn.install).toBe("yarn install");
      });

      it("provides correct build command with run", () => {
        expect(PM_COMMANDS.yarn.build).toBe("yarn run build");
      });

      it("provides correct add command", () => {
        expect(PM_COMMANDS.yarn.add("pkg1 pkg2")).toBe("yarn add pkg1 pkg2");
      });

      it("provides correct exec command (dlx)", () => {
        expect(PM_COMMANDS.yarn.exec).toBe("yarn dlx");
      });
    });

    describe("bun", () => {
      it("provides correct install command", () => {
        expect(PM_COMMANDS.bun.install).toBe("bun install");
      });

      it("provides correct build command with run", () => {
        expect(PM_COMMANDS.bun.build).toBe("bun run build");
      });

      it("provides correct add command", () => {
        expect(PM_COMMANDS.bun.add("pkg1 pkg2")).toBe("bun add pkg1 pkg2");
      });

      it("provides correct exec command (x)", () => {
        expect(PM_COMMANDS.bun.exec).toBe("bun x");
      });
    });
  });
});

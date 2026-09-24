import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectPackageManager, PM_COMMANDS } from "./package-manager";

describe("package-manager", () => {
  describe("detectPackageManager", () => {
    let cwd: string;

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
      vi.stubEnv("npm_config_user_agent", undefined);
    });

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it.each(["pnpm", "npm", "yarn", "bun"] as const)(
      "uses %s from the launcher when there is no project metadata",
      (pm) => {
        vi.stubEnv("npm_config_user_agent", `${pm}/1.0.0 node/24.0.0`);
        expect(detectPackageManager(cwd)).toBe(pm);
      },
    );

    it.each(["pnpm", "npm", "yarn", "bun"] as const)(
      "prefers declared %s over conflicting lockfiles and launcher",
      (pm) => {
        fs.writeFileSync(
          path.join(cwd, "package.json"),
          JSON.stringify({ packageManager: `${pm}@1.0.0` }),
        );
        fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "");
        fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}");
        vi.stubEnv(
          "npm_config_user_agent",
          pm === "npm" ? "pnpm/11.0.8" : "npm/11.8.0",
        );
        expect(detectPackageManager(cwd)).toBe(pm);
      },
    );

    it.each([
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
    ] as const)(
      "detects %s with an absent or conflicting launcher",
      (lockfile, pm) => {
        fs.writeFileSync(path.join(cwd, lockfile), "");
        expect(detectPackageManager(cwd)).toBe(pm);

        vi.stubEnv(
          "npm_config_user_agent",
          pm === "npm" ? "pnpm/11.0.8" : "npm/11.8.0",
        );
        expect(detectPackageManager(cwd)).toBe(pm);
      },
    );

    it.each([
      "invalid json",
      "null",
      "{}",
      '{"packageManager":null}',
      '{"packageManager":42}',
      '{"packageManager":"unknown@1.0.0"}',
    ])("falls back to lockfiles for unusable package.json: %s", (content) => {
      fs.writeFileSync(path.join(cwd, "package.json"), content);
      fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}");
      vi.stubEnv("npm_config_user_agent", "pnpm/11.0.8");
      expect(detectPackageManager(cwd)).toBe("npm");
    });

    it("defaults to pnpm without project or launcher metadata", () => {
      expect(detectPackageManager(cwd)).toBe("pnpm");
    });

    it("allows callers to retain an npm fallback", () => {
      expect(detectPackageManager(cwd, "npm")).toBe("npm");
    });

    it("ignores unknown launchers", () => {
      vi.stubEnv("npm_config_user_agent", "unknown/1.0.0 node/24.0.0");
      expect(detectPackageManager(cwd)).toBe("pnpm");
      expect(detectPackageManager(cwd, "npm")).toBe("npm");
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

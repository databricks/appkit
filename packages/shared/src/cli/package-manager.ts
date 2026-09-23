import fs from "node:fs";
import path from "node:path";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/**
 * Detects the package manager for a given working directory.
 * Detection order:
 * 1. process.env.npm_config_user_agent (e.g. "pnpm/8.6.0 ...")
 * 2. Lockfile presence in cwd (pnpm-lock.yaml, yarn.lock, bun.lockb, package-lock.json)
 * 3. Default to pnpm
 */
export function detectPackageManager(cwd: string): PackageManager {
  // Check environment variable first (npm_config_user_agent set by the package manager)
  const userAgent = process.env.npm_config_user_agent;
  if (userAgent) {
    const firstToken = userAgent.split("/")[0];
    if (
      firstToken === "pnpm" ||
      firstToken === "npm" ||
      firstToken === "yarn" ||
      firstToken === "bun"
    ) {
      return firstToken;
    }
  }

  // Check for lockfile presence
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm";

  // Default fallback
  return "pnpm";
}

/**
 * Command strings for each package manager.
 * Per-PM forms for: install, build (script), add, exec.
 * Scripts always use explicit `run` (e.g., `pnpm run build`).
 */
export const PM_COMMANDS: Record<
  PackageManager,
  {
    install: string;
    build: string;
    add: (pkgs: string) => string;
    exec: string;
  }
> = {
  pnpm: {
    install: "pnpm install",
    build: "pnpm run build",
    add: (pkgs) => `pnpm add ${pkgs}`,
    exec: "pnpm exec",
  },
  npm: {
    install: "npm install",
    build: "npm run build",
    add: (pkgs) => `npm install ${pkgs}`,
    exec: "npx",
  },
  yarn: {
    install: "yarn install",
    build: "yarn run build",
    add: (pkgs) => `yarn add ${pkgs}`,
    exec: "yarn dlx",
  },
  bun: {
    install: "bun install",
    build: "bun run build",
    add: (pkgs) => `bun add ${pkgs}`,
    exec: "bun x",
  },
};

export type { PackageManager };

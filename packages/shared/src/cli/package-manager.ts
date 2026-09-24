import fs from "node:fs";
import path from "node:path";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

function isPackageManager(value: string): value is PackageManager {
  return (
    value === "pnpm" || value === "npm" || value === "yarn" || value === "bun"
  );
}

/**
 * Prefers the project's packageManager field, then its lockfiles, then
 * npm_config_user_agent. The launcher (e.g. npx) may use a different manager.
 */
export function detectPackageManager(
  cwd: string,
  fallback: PackageManager = "pnpm",
): PackageManager {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
    ) as { packageManager?: unknown } | null;
    if (typeof pkg?.packageManager === "string") {
      const name = pkg.packageManager.split("@")[0];
      if (isPackageManager(name)) return name;
    }
  } catch {
    // A missing or unreadable manifest still permits lockfile detection.
  }

  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (
    fs.existsSync(path.join(cwd, "bun.lock")) ||
    fs.existsSync(path.join(cwd, "bun.lockb"))
  ) {
    return "bun";
  }
  if (
    fs.existsSync(path.join(cwd, "package-lock.json")) ||
    fs.existsSync(path.join(cwd, "npm-shrinkwrap.json"))
  ) {
    return "npm";
  }

  const userAgent = process.env.npm_config_user_agent;
  if (userAgent) {
    const firstToken = userAgent.split("/")[0];
    if (isPackageManager(firstToken)) return firstToken;
  }

  return fallback;
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

import fs from "node:fs";
import path from "node:path";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

function isPackageManager(value: string): value is PackageManager {
  return (
    value === "pnpm" || value === "npm" || value === "yarn" || value === "bun"
  );
}

/**
 * The manager a directory's own files name: its package.json's packageManager
 * field, else its lockfile. null when neither names one.
 */
export function declaredPackageManager(dir: string): PackageManager | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
    ) as { packageManager?: unknown } | null;
    if (typeof pkg?.packageManager === "string") {
      const name = pkg.packageManager.split("@")[0];
      if (isPackageManager(name)) return name;
    }
  } catch {
    // A missing or unreadable manifest still permits lockfile detection.
  }

  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (
    fs.existsSync(path.join(dir, "bun.lock")) ||
    fs.existsSync(path.join(dir, "bun.lockb"))
  ) {
    return "bun";
  }
  if (
    fs.existsSync(path.join(dir, "package-lock.json")) ||
    fs.existsSync(path.join(dir, "npm-shrinkwrap.json"))
  ) {
    return "npm";
  }
  return null;
}

/**
 * Prefers the project's packageManager field, then its lockfiles, then
 * npm_config_user_agent. The launcher (e.g. npx) may use a different manager.
 */
export function detectPackageManager(
  cwd: string,
  fallback: PackageManager = "pnpm",
): PackageManager {
  const declared = declaredPackageManager(cwd);
  if (declared) return declared;

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

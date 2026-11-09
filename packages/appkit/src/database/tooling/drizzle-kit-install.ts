import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  declaredPackageManager,
  detectPackageManager,
  type PackageManager,
} from "../../../../shared/src/cli/package-manager";
import { DRIZZLE_KIT_VERSION, hasDrizzleKit } from "./migrations";

/** Runs a command in `cwd`; throws when it fails. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => void;

/** Each manager's exact dev-dependency install. */
const INSTALL_ARGS: Record<PackageManager, readonly string[]> = {
  pnpm: ["add", "-D", "-E"],
  yarn: ["add", "-D", "-E"],
  bun: ["add", "-d", "--exact"],
  npm: ["install", "--save-dev", "--save-exact"],
};

interface Install {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The install with the manager the app declares, by packageManager field or
 * lockfile, in its own directory or the nearest ancestor's (a workspace member
 * has neither; its root does). Without one, the manager that launched this
 * command, else npm.
 */
export function drizzleKitInstall(root: string): Install {
  let manager: PackageManager | null = null;
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    manager = declaredPackageManager(dir);
    if (manager || dir === path.dirname(dir)) break;
  }
  const command = manager ?? detectPackageManager(root, "npm");
  return {
    command,
    args: [...INSTALL_ARGS[command], `drizzle-kit@${DRIZZLE_KIT_VERSION}`],
  };
}

export const runCommand: RunCommand = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    // Windows runs package managers through their .cmd shims.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${[command, ...args].join(" ")} exited with code ${result.status}${output ? `: ${output}` : ""}`,
    );
  }
};

/**
 * Install drizzle-kit as an exact dev dependency when the app cannot resolve
 * it. Returns the command it ran; null when drizzle-kit was there, or there is
 * no package.json to add it to.
 */
export function ensureDrizzleKit(
  root: string,
  run: RunCommand,
  onStep: (message: string) => void,
): string | null {
  if (hasDrizzleKit(root) || !fs.existsSync(path.join(root, "package.json"))) {
    return null;
  }
  const { command, args } = drizzleKitInstall(root);
  const line = [command, ...args].join(" ");
  onStep(
    `Installing drizzle-kit ${DRIZZLE_KIT_VERSION}, which writes migrations (${line})`,
  );
  try {
    run(command, args, root);
  } catch (error) {
    throw new Error(
      `Installing drizzle-kit failed. Run \`${line}\`, then rerun \`appkit db init\`.`,
      { cause: error },
    );
  }
  return line;
}

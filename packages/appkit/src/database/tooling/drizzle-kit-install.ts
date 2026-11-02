import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DRIZZLE_KIT_VERSION, hasDrizzleKit } from "./migrations";

/** Runs a command in `cwd`; throws when it fails. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => void;

/** Exact dev-dependency installs, by the lockfile that names the package manager. */
const MANAGERS: ReadonlyArray<
  readonly [lockfile: string, command: string, args: readonly string[]]
> = [
  ["pnpm-lock.yaml", "pnpm", ["add", "-D", "-E"]],
  ["yarn.lock", "yarn", ["add", "-D", "-E"]],
  ["bun.lock", "bun", ["add", "-d", "--exact"]],
  ["bun.lockb", "bun", ["add", "-d", "--exact"]],
  ["package-lock.json", "npm", ["install", "--save-dev", "--save-exact"]],
];

interface Install {
  readonly command: string;
  readonly args: readonly string[];
}

/** The install with the package manager whose lockfile is nearest `root`; npm without one. */
export function drizzleKitInstall(root: string): Install {
  const spec = `drizzle-kit@${DRIZZLE_KIT_VERSION}`;
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    for (const [lockfile, command, args] of MANAGERS) {
      if (fs.existsSync(path.join(dir, lockfile))) {
        return { command, args: [...args, spec] };
      }
    }
    if (dir === path.dirname(dir)) break;
  }
  return {
    command: "npm",
    args: ["install", "--save-dev", "--save-exact", spec],
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

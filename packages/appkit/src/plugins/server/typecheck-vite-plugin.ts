import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";

import { createLogger } from "../../logging/logger";

const logger = createLogger("server:typecheck");

const TS_FILE = /\.[cm]?tsx?$/;
const DEBOUNCE_MS = 300;

interface TypecheckPluginOptions {
  /** App root whose `package.json` declares the `typecheck` script. */
  projectRoot: string;
}

function readTypecheckScript(projectRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"),
    );
    const script = pkg?.scripts?.typecheck;
    return typeof script === "string" && script.trim() ? script : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs the app's `typecheck` script in the background of the dev server and
 * logs its errors. Vite and `tsx watch` only strip types, so without this a
 * type error stays invisible until deployment validation runs the same script.
 *
 * Runs once at startup (tsx restarts the process on server edits) and again
 * after TypeScript files change. Inert when the app has no `typecheck` script.
 */
export function typecheckPlugin(options: TypecheckPluginOptions): Plugin {
  const projectRoot = path.resolve(options.projectRoot);
  const script = readTypecheckScript(projectRoot);

  let child: ChildProcess | undefined;
  let rerun = false;
  let timer: NodeJS.Timeout | undefined;
  let lastPassed: boolean | undefined;
  let closed = false;

  function run() {
    if (closed || !script) return;
    if (child) {
      rerun = true;
      return;
    }

    let output = "";
    const proc = spawn(script, {
      cwd: projectRoot,
      shell: true,
      env: {
        ...process.env,
        PATH: `${path.join(projectRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    child = proc;
    proc.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    proc.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    proc.on("error", (error) => {
      logger.debug("Cannot run the typecheck script: %O", error);
    });
    proc.on("close", (code) => {
      child = undefined;
      if (closed) return;
      // A file changed mid-run, so this result is already stale.
      if (rerun) {
        rerun = false;
        run();
        return;
      }
      if (code === 0) {
        if (lastPassed !== true) logger.info("No type errors.");
        lastPassed = true;
        return;
      }
      lastPassed = false;
      logger.error(
        "Type errors found. The app still runs, but deployment validation fails until they are fixed:\n%s",
        output.trim(),
      );
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  return {
    name: "appkit-typecheck",
    apply: () => script !== undefined,

    configureServer(server) {
      // Regenerated `shared/appkit-types` declarations can change the result.
      server.watcher.add(path.join(projectRoot, "shared"));
      for (const event of ["add", "change", "unlink"] as const) {
        server.watcher.on(event, (file: string) => {
          if (TS_FILE.test(file)) schedule();
        });
      }
      schedule();
    },

    buildEnd() {
      closed = true;
      clearTimeout(timer);
      child?.kill();
    },
  };
}

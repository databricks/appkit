import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// npm's own fetch timeout (5 min, retried) could outlast the whole wait.
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Waits until the npm registry serves `name@version` for every name. A
 * just-published version takes minutes to reach the registry's packument and
 * CDN cache, so installing it right away fails with ETARGET.
 */
export async function waitForNpmVersion(
  names: string[],
  version: string,
  {
    cwd = process.cwd(),
    timeoutMs = 10 * 60_000,
    delayMs = 5_000,
    maxDelayMs = 30_000,
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const name of names) {
    for (let delay = delayMs; ; delay = Math.min(delay * 2, maxDelayMs)) {
      // npm view already revalidates its cache by default; --prefer-online
      // keeps it that way if a config default changes.
      const { stdout, stderr } = await execFileAsync(
        "npm",
        ["view", `${name}@${version}`, "version", "--prefer-online"],
        {
          cwd,
          timeout: Math.max(
            1,
            Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()),
          ),
        },
      ).catch((error) => ({
        stdout: "",
        stderr: error.killed
          ? "npm view did not answer in time"
          : String(error.stderr || error.message),
      }));
      if (stdout.trim() === version) {
        console.log(`✓ ${name}@${version} is on the npm registry`);
        break;
      }
      if (Date.now() + delay > deadline) {
        throw new Error(
          `${name}@${version} is still not on the npm registry after ${Math.round(timeoutMs / 1000)}s. ` +
            `Last npm view output:\n${stderr.trim() || stdout.trim()}`,
        );
      }
      console.warn(
        `${name}@${version} is not on the npm registry yet, checking again in ${delay / 1000}s...`,
      );
      await sleep(delay);
    }
  }
}

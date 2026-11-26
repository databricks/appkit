import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Not published yet (E404), a registry hiccup, or a network error npm itself
// retries (make-fetch-happen's list); anything else won't go away by waiting.
const RETRYABLE = new RegExp(
  "^(E404|E408|E429|E5\\d\\d|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EADDRINUSE|ETIMEDOUT|" +
    "ECONNECTIONTIMEOUT|EIDLETIMEOUT|ERESPONSETIMEOUT|ETRANSFERTIMEOUT)$",
);

/**
 * Waits until the npm registry serves `name@version` for every name. A
 * just-published version takes minutes to reach the registry's packument and
 * CDN cache, so installing it right away fails with ETARGET. Errors that
 * waiting can't fix (auth, config, no npm) fail at once.
 */
export async function waitForNpmVersion(
  names: string[],
  version: string,
  {
    cwd = process.cwd(),
    timeoutMs = 10 * 60_000,
    delayMs = 5_000,
    maxDelayMs = 30_000,
    lastProbeMs = 30_000,
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const name of names) {
    for (let delay = delayMs; ; delay = Math.min(delay * 2, maxDelayMs)) {
      // A probe may run until the deadline (npm's own fetch timeout is 5
      // minutes, retried); the one at the deadline still gets lastProbeMs.
      const answer = await npmView(
        name,
        version,
        cwd,
        Math.max(deadline - Date.now(), lastProbeMs),
      );
      if (answer.code === "OK") {
        console.log(`✓ ${name}@${version} is on the npm registry`);
        break;
      }
      if (!RETRYABLE.test(answer.code)) {
        throw new Error(
          `npm view ${name}@${version} failed (${answer.code}): ${answer.summary}`,
        );
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `${name}@${version} is still not on the npm registry after ${Math.round(timeoutMs / 1000)}s. ` +
            `Last npm view answer: ${answer.code} ${answer.summary}`,
        );
      }
      const wait = Math.min(delay, left);
      console.warn(
        `${name}@${version} is not on the npm registry yet (${answer.code}), checking again in ${wait / 1000}s...`,
      );
      await sleep(wait);
    }
  }
}

function npmView(
  name: string,
  version: string,
  cwd: string,
  timeout: number,
): Promise<{ code: string; summary: string }> {
  // --json: plain output changes shape when the environment sets
  // npm_config_json, and errors come back with npm's error code.
  return execFileAsync(
    "npm",
    ["view", `${name}@${version}`, "version", "--json", "--prefer-online"],
    { cwd, timeout },
  ).then(
    ({ stdout }) =>
      parseJson(stdout) === version
        ? { code: "OK", summary: "" }
        : {
            code: "E404",
            summary: `npm view printed ${stdout.trim() || "nothing"}`,
          },
    (error) => {
      if (error.killed) {
        return {
          code: "ETIMEDOUT",
          summary: "npm view did not answer in time",
        };
      }
      const reported = parseJson(error.stdout)?.error;
      return {
        code: String(reported?.code ?? error.code),
        summary: String(
          reported?.summary ?? (error.stderr || error.message),
        ).trim(),
      };
    },
  );
}

function parseJson(text: string | undefined) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

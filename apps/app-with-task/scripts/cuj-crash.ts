#!/usr/bin/env tsx
/**
 * TaskFlow private-preview CUJ — headless reproducer.
 *
 * Drives the same flow the browser exercises, but as a single script so
 * we can verify durability without HTML/JS in the loop:
 *
 *   1. POST /api/analytics/query/slow_aggregate  (SSE stream begins)
 *   2. After the first event lands, capture the `x-appkit-task-idempotency-key`
 *      header and the `id` of the most recent SSE frame.
 *   3. Send SIGKILL to the server process. The SSE socket dies; the
 *      WAL row is already on disk (`statement_submitted` checkpoint).
 *   4. Wait for the user to restart the server (`pnpm dev` in another
 *      terminal). The script polls /health until 200.
 *   5. Re-POST the **same** query with the same params. The deterministic
 *      idempotency key matches; the engine recovers inline; the script
 *      drains the SSE stream to its terminal frame and prints the row
 *      count delta + timing.
 *
 * Usage:
 *   tsx scripts/cuj-crash.ts [--query slow_aggregate|heavy_join] [--port 8000]
 *
 * Assumes:
 *   - The server is already running (`pnpm dev`) when the script starts.
 *   - The user re-runs `pnpm dev` after seeing the "kill issued" log.
 */

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

interface Args {
  query: "slow_aggregate" | "heavy_join";
  port: number;
  killAfterMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? (argv[idx + 1] ?? fallback) : fallback;
  };
  return {
    query: get("--query", "slow_aggregate") as Args["query"],
    port: Number(get("--port", "8000")),
    killAfterMs: Number(get("--kill-after-ms", "1500")),
  };
}

function findServerPid(port: number): number | null {
  const res = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  const pid = parseInt(res.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function waitForHealth(baseUrl: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await sleep(500);
  }
  throw new Error(
    `Server at ${baseUrl} did not come back within ${timeoutMs}ms`,
  );
}

interface DrainOutcome {
  idempotencyKey: string | null;
  terminalEvent: string | null;
  lastEventId: string | null;
  payload: unknown;
  bytes: number;
}

async function drainQueryStream(
  baseUrl: string,
  query: Args["query"],
  options: { killAfterMs?: number; serverPid?: number | null } = {},
): Promise<DrainOutcome> {
  const url = `${baseUrl}/api/analytics/query/${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const startedAt = Date.now();

  const serverPid = options.serverPid ?? null;
  const killAfterMs = options.killAfterMs ?? null;
  const killTimer =
    killAfterMs != null && serverPid != null
      ? setTimeout(() => {
          console.log(
            `→ killing server pid=${serverPid} after ${killAfterMs}ms`,
          );
          try {
            process.kill(serverPid, "SIGKILL");
          } catch (err) {
            console.error("kill failed:", err);
          }
        }, killAfterMs)
      : null;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parameters: {}, format: "JSON" }),
      signal: controller.signal,
    });
  } catch (err) {
    if (killTimer) clearTimeout(killTimer);
    throw err;
  }

  const idempotencyKey =
    resp.headers.get("x-appkit-task-idempotency-key") ??
    resp.headers.get("X-AppKit-Task-Idempotency-Key");

  if (!resp.body) throw new Error("no response body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let bytes = 0;
  let lastEventId: string | null = null;
  let terminalEvent: string | null = null;
  let payload: unknown = null;
  let currentEvent: string | null = null;
  let currentData: string | null = null;
  let currentId: string | null = null;

  const flushFrame = () => {
    if (currentEvent === null && currentData === null) return;
    if (currentId !== null) lastEventId = currentId;
    const ev = currentEvent ?? "message";
    if (ev === "data" || ev === "completed" || ev === "failed") {
      terminalEvent = ev;
      try {
        payload = currentData ? JSON.parse(currentData) : null;
      } catch {
        payload = currentData;
      }
    }
    currentEvent = null;
    currentData = null;
    currentId = null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buf += decoder.decode(value, { stream: true });

      while (true) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);

        if (line === "") {
          flushFrame();
          if (terminalEvent === "completed" || terminalEvent === "failed") {
            controller.abort();
            break;
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        else if (line.startsWith("data:"))
          currentData = (currentData ?? "") + line.slice(5).trimStart();
        else if (line.startsWith("id:")) currentId = line.slice(3).trim();
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/aborted|terminated|network/i.test(msg)) throw err;
  } finally {
    if (killTimer) clearTimeout(killTimer);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `← stream closed after ${elapsedMs}ms terminal=${terminalEvent ?? "<none>"} bytes=${bytes} lastEventId=${lastEventId ?? "<none>"}`,
  );

  return { idempotencyKey, terminalEvent, lastEventId, payload, bytes };
}

async function main() {
  const args = parseArgs();
  const baseUrl = `http://localhost:${args.port}`;
  console.log(`▶ CUJ start  query=${args.query}  base=${baseUrl}`);

  // Pre-flight: server must already be up.
  await waitForHealth(baseUrl, 5_000).catch((e) => {
    console.error(
      `Server at ${baseUrl} is not up. Start it with \`pnpm dev\` first.`,
    );
    throw e;
  });

  const pid = findServerPid(args.port);
  console.log(`✓ server up, pid=${pid ?? "<unknown>"}`);

  // Phase 1 — submit + kill mid-flight.
  console.log("\n── phase 1: submit query, kill mid-flight ──");
  const phase1 = await drainQueryStream(baseUrl, args.query, {
    killAfterMs: args.killAfterMs,
    serverPid: pid,
  });
  console.log(
    `  idempotencyKey=${phase1.idempotencyKey ?? "<missing>"}  terminal=${phase1.terminalEvent ?? "<aborted>"}`,
  );

  if (!phase1.idempotencyKey) {
    throw new Error(
      "no idempotency key captured — bridge did not emit `x-appkit-task-idempotency-key`. " +
        "Check executeTask wiring.",
    );
  }
  if (phase1.terminalEvent === "completed") {
    console.warn(
      "⚠ query finished before we could kill the server. Pick the heavier " +
        "`--query heavy_join` or shorten `--kill-after-ms`.",
    );
  }

  // Phase 2 — wait for the human to restart the server.
  console.log(
    "\n── phase 2: server is dead. Run `pnpm dev` in another terminal. ──",
  );
  await waitForHealth(baseUrl);
  console.log("✓ server back up");

  // Phase 3 — re-issue the SAME query; expect dedup → recovery.
  console.log(
    "\n── phase 3: re-issuing same query (expect dedup + recover) ──",
  );
  const phase2 = await drainQueryStream(baseUrl, args.query);
  console.log(
    `  idempotencyKey=${phase2.idempotencyKey ?? "<missing>"}  terminal=${phase2.terminalEvent ?? "<none>"}`,
  );

  // Verdict.
  const sameKey = phase1.idempotencyKey === phase2.idempotencyKey;
  const recovered =
    phase2.terminalEvent === "data" || phase2.terminalEvent === "completed";
  console.log("\n──────────────  CUJ verdict  ──────────────");
  console.log(`  same idempotency key across restart : ${sameKey}`);
  console.log(`  second request reached terminal     : ${recovered}`);
  console.log(`  payload bytes (phase 2)             : ${phase2.bytes}`);
  if (sameKey && recovered) {
    console.log("\n✅ TaskFlow recovered the durable task across crash.");
    process.exit(0);
  } else {
    console.log(
      "\n❌ Recovery did not complete. Check server logs for `on-demand recovery` traces.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

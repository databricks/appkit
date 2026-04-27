#!/usr/bin/env tsx
/**
 * sse-timeout-probe: Empirically locate the idle-timeout ceiling that kills SSE
 * streams on Databricks Apps.
 *
 * Background: internal field feedback (ES-1742245, and the EMEA Apps "gaps that
 * matter" doc) reports ~75% of SSE connections drop mid-stream through the Apps
 * reverse proxy. The source doc claims the drop is distinct from any idle timeout,
 * but the ticket's own diagnosis (Naïm Achahboun) suggests the drop *is* caused by
 * the effective request timeout — multi-agent LLM calls take varying durations, so
 * ~30% finish under the ceiling and ~70% exceed it.
 *
 * This probe reproduces the condition deterministically: it opens one SSE connection
 * per configured duration, keeps it idle (or paced by a configurable heartbeat), and
 * records how long the connection survived and how it was terminated. Running it
 * against a known-good origin (EKS / localhost) vs a Databricks Apps deployment
 * gives you the per-layer ceiling without having to triangulate from noisy LLM
 * traces.
 *
 * Usage: tsx tools/sse-timeout-probe/probe.ts --base-url <URL> [flags]
 *   See --help for flags.
 */

import { performance } from "node:perf_hooks";

interface ProbeConfig {
  baseUrl: string;
  path: string;
  durationsMs: number[];
  heartbeatMs: number;
  headers: Record<string, string>;
  jsonOutput: boolean;
}

interface ProbeResult {
  targetDurationMs: number;
  actualLifetimeMs: number;
  outcome: "completed" | "server-close" | "network-error" | "client-hard-timeout";
  detail?: string;
  bytesReceived: number;
  firstByteMs?: number;
}

// Tolerance for distinguishing "server held the full target duration" from "server closed early":
// network/event-loop jitter can shave tens of ms off a clean run, so anything within 500ms of
// the target counts as completed.
const COMPLETION_TOLERANCE_MS = 500;

function parseArgs(argv: string[]): ProbeConfig {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args.set(key, value);
    }
  }

  if (args.has("help") || !args.has("base-url")) {
    process.stderr.write(
      [
        "usage: tsx tools/sse-timeout-probe/probe.ts --base-url <URL> [flags]",
        "",
        "flags:",
        "  --base-url <URL>         required. Base URL of the SSE-serving app.",
        "  --path <PATH>            SSE endpoint path. Default: /sse-probe",
        "  --durations <LIST>       comma-separated ms, one connection per entry.",
        "                           Default: 30000,60000,90000,120000,150000,180000,240000,300000",
        "  --heartbeat <MS>         if >0, send a heartbeat comment every MS on the",
        "                           *server* side (requires --path to point at the",
        "                           companion server). If 0, connection is fully idle.",
        "                           Default: 0",
        "  --header <K=V>           extra request header. Repeatable.",
        "  --json                   emit machine-readable JSON line per result.",
        "  --help                   show this message.",
        "",
      ].join("\n"),
    );
    process.exit(args.has("help") ? 0 : 2);
  }

  const headers: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--header" && argv[i + 1]) {
      const [k, ...rest] = argv[i + 1].split("=");
      headers[k] = rest.join("=");
      i++;
    }
  }

  const durations = (
    args.get("durations") ?? "30000,60000,90000,120000,150000,180000,240000,300000"
  )
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  return {
    baseUrl: args.get("base-url")!.replace(/\/$/, ""),
    path: args.get("path") ?? "/sse-probe",
    durationsMs: durations,
    heartbeatMs: Number.parseInt(args.get("heartbeat") ?? "0", 10),
    headers,
    jsonOutput: args.get("json") === "true",
  };
}

async function probeOnce(config: ProbeConfig, targetDurationMs: number): Promise<ProbeResult> {
  const url = new URL(config.path, config.baseUrl);
  url.searchParams.set("hold-ms", String(targetDurationMs));
  url.searchParams.set("heartbeat-ms", String(config.heartbeatMs));

  const start = performance.now();
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(new Error("probe-hard-timeout")), targetDurationMs + 15_000);

  let bytesReceived = 0;
  let firstByteMs: number | undefined;
  let outcome: ProbeResult["outcome"] = "completed";
  let detail: string | undefined;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        ...config.headers,
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      return {
        targetDurationMs,
        actualLifetimeMs: performance.now() - start,
        outcome: "server-close",
        detail: `HTTP ${resp.status} ${resp.statusText}`,
        bytesReceived: 0,
      };
    }

    if (!resp.body) {
      return {
        targetDurationMs,
        actualLifetimeMs: performance.now() - start,
        outcome: "network-error",
        detail: "no response body",
        bytesReceived: 0,
      };
    }

    const reader = resp.body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (firstByteMs === undefined && value) firstByteMs = performance.now() - start;
      if (done) {
        const lifetimeMs = performance.now() - start;
        outcome =
          lifetimeMs >= targetDurationMs - COMPLETION_TOLERANCE_MS ? "completed" : "server-close";
        break;
      }
      if (value) bytesReceived += value.byteLength;
    }
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" && (e as Error & { cause?: Error }).cause?.message === "probe-hard-timeout") {
      outcome = "client-hard-timeout";
      detail = "client-side hard-timeout fired (server never closed the connection)";
    } else {
      outcome = "network-error";
      detail = e.message;
    }
  } finally {
    clearTimeout(hardTimeout);
  }

  return {
    targetDurationMs,
    actualLifetimeMs: performance.now() - start,
    outcome,
    detail,
    bytesReceived,
    firstByteMs,
  };
}

function formatResult(r: ProbeResult): string {
  const lifeSec = (r.actualLifetimeMs / 1000).toFixed(1);
  const ttfb = r.firstByteMs ? `${(r.firstByteMs / 1000).toFixed(1)}s` : "n/a";
  const suffix = r.detail ? ` (${r.detail})` : "";
  return `  target=${r.targetDurationMs / 1000}s  lived=${lifeSec}s  outcome=${r.outcome}  bytes=${r.bytesReceived}  ttfb=${ttfb}${suffix}`;
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  if (!config.jsonOutput) {
    process.stdout.write(`sse-timeout-probe → ${config.baseUrl}${config.path}\n`);
    process.stdout.write(`  durations: ${config.durationsMs.map((d) => `${d / 1000}s`).join(", ")}\n`);
    process.stdout.write(`  heartbeat: ${config.heartbeatMs === 0 ? "none (fully idle)" : `${config.heartbeatMs}ms`}\n\n`);
  }

  for (const duration of config.durationsMs) {
    const result = await probeOnce(config, duration);
    if (config.jsonOutput) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${formatResult(result)}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${(err as Error).message}\n`);
  process.exit(1);
});

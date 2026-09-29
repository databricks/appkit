import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../../../logging";
import type { OmnigentStatus } from "../types";
import { RuntimeLayout, childEnv, writeUserConfig } from "./env";
import { ModelGateway } from "./gateway";
import { ensureGatewayTls, type GatewayTls } from "./tls";

const logger = createLogger("omnigent:runtime");

const PYTHON_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "python",
);

interface RuntimeOptions {
  root: string;
  appDir: string;
  python: string;
  /** The real workspace URL. */
  upstream: string;
  /** Bearer for model calls (the app's service principal). */
  token: () => Promise<string>;
  hostIdleMs: number;
}

interface HostEntry {
  proc: ChildProcess;
  hostId: string;
  userId: string;
  ready: Promise<HostEntry>;
  /** Set when the host never came online; the entry is then replaced, not reused. */
  failed?: boolean;
  lastUsed: number;
}

/**
 * Omnigent embedded in the app: one server on loopback in header-auth mode
 * (under a random header name) and one host per active user, supervised as
 * child processes.
 */
export class OmnigentRuntime {
  readonly layout: RuntimeLayout;
  /** Header the server trusts for identity. Random, so no other process can guess it. */
  readonly authHeader = `x-appkit-omnigent-user-${randomBytes(12).toString("hex")}`;
  private tls!: GatewayTls;
  private gateway!: ModelGateway;
  private server?: ChildProcess;
  private serverReady?: Promise<void>;
  private readonly hosts = new Map<string, HostEntry>();
  private port = 0;
  private stopping = false;
  private reaper?: NodeJS.Timeout;
  private lastError?: string;
  private restartDelayMs = 3000;
  private version?: string;

  constructor(private readonly opts: RuntimeOptions) {
    this.layout = new RuntimeLayout(opts.root);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.layout.create();
    this.tls = ensureGatewayTls(this.layout.tls, this.layout.bin);
    this.gateway = new ModelGateway({
      upstream: this.opts.upstream,
      token: this.opts.token,
      tls: { key: this.tls.key, cert: this.tls.cert },
    });
    await this.gateway.start();

    this.port = await freePort();
    this.startServer();
    this.reaper = setInterval(() => this.reapIdleHosts(), 60_000);
    this.reaper.unref();
  }

  /** Resolves once the server answers `/health`. */
  whenReady(): Promise<void> {
    return (
      this.serverReady ??
      Promise.reject(new Error("Omnigent runtime not started"))
    );
  }

  private startServer(): void {
    const args = [
      this.opts.python,
      path.join(PYTHON_DIR, "watchdog.py"),
      "omnigent",
      "server",
      "--host",
      "127.0.0.1",
      "-p",
      String(this.port),
      "--no-open",
    ];
    const home = path.join(this.layout.serverDir, "home");
    fs.mkdirSync(home, { recursive: true });
    writeUserConfig(home, this.gateway);
    const env = childEnv(process.env, {
      home,
      dataDir: path.join(this.layout.serverDir, "data"),
      gateway: this.gateway,
      caBundle: this.tls.bundleFile,
      caCert: this.tls.certFile,
      pathPrepend: [path.dirname(this.opts.python)],
      extra: {
        OMNIGENT_AUTH_PROVIDER: "header",
        OMNIGENT_AUTH_HEADER: this.authHeader,
      },
    });
    this.server = this.spawn("server", args, env, this.layout.serverDir);
    this.server.once("exit", (code, signal) => {
      if (this.stopping) return;
      this.lastError = `Omnigent server exited (${code ?? signal}); restarting`;
      logger.warn("%s. Log: %s", this.lastError, this.logFile("server"));
      const delay = this.restartDelayMs;
      this.restartDelayMs = Math.min(delay * 2, 60_000);
      setTimeout(() => !this.stopping && this.startServer(), delay).unref();
    });
    this.serverReady = this.waitFor(
      async () => (await fetch(`${this.url}/health`)).ok,
      10 * 60_000,
      "Omnigent server",
    ).then(async () => {
      this.lastError = undefined;
      this.restartDelayMs = 3000;
      try {
        const info = await this.request("GET", "/v1/info", "appkit-runtime");
        this.version = (
          (await info.json()) as { server_version?: string }
        ).server_version;
      } catch {}
      logger.info("Omnigent server ready on %s", this.url);
    });
    this.serverReady.catch((e) => {
      this.lastError = String(e);
    });
  }

  /** Starts (or reuses) the host that runs this user's sessions. */
  async ensureHost(email: string): Promise<HostEntry> {
    await this.whenReady();
    const current = this.hosts.get(email);
    if (current?.failed) {
      // Alive but never registered: take it down and start a fresh host.
      killGroup(current.proc, "SIGKILL");
      this.hosts.delete(email);
    } else if (
      current &&
      current.proc.exitCode === null &&
      current.proc.signalCode === null
    ) {
      current.lastUsed = Date.now();
      return current.ready;
    }
    const userId = RuntimeLayout.userId(email);
    // Stable per app and user, so a thread from before a restart re-binds to its host.
    const hostId = createHash("sha256")
      .update(
        `${this.opts.upstream}/apps/${process.env.DATABRICKS_APP_NAME ?? "appkit"}/${email.toLowerCase()}`,
      )
      .digest("hex")
      .slice(0, 32);
    const home = this.layout.userHome(userId);
    const work = this.layout.userWork(userId);
    for (const d of [home, this.layout.userData(userId), work])
      fs.mkdirSync(d, { recursive: true });
    writeUserConfig(home, this.gateway);
    const env = childEnv(process.env, {
      home,
      dataDir: this.layout.userData(userId),
      gateway: this.gateway,
      caBundle: this.tls.bundleFile,
      caCert: this.tls.certFile,
      pathPrepend: [
        path.dirname(this.opts.python),
        path.join(this.opts.appDir, "node_modules", ".bin"),
      ],
      extra: {
        OMNIGENT_HOST_ID: hostId,
        OMNIGENT_HOST_NAME: `appkit-${userId}`,
        OMNIGENT_DATABRICKS_EXTRA_HEADERS: JSON.stringify({
          [this.authHeader]: email,
        }),
      },
    });
    const proc = this.spawn(
      `host-${userId}`,
      [
        this.opts.python,
        path.join(PYTHON_DIR, "watchdog.py"),
        "omnigent",
        "host",
        "--server",
        this.url,
      ],
      env,
    );
    const entry: HostEntry = {
      proc,
      hostId,
      userId,
      lastUsed: Date.now(),
      ready: undefined as never,
    };
    entry.ready = this.waitFor(
      async () => {
        const r = await this.request("GET", "/v1/hosts", email);
        const { hosts = [] } = (await r.json()) as {
          hosts?: Array<{ host_id: string; status: string }>;
        };
        return hosts.some((h) => h.host_id === hostId && h.status === "online")
          ? entry
          : undefined;
      },
      120_000,
      "Omnigent host",
    );
    entry.ready.catch(() => {
      entry.failed = true;
    });
    this.hosts.set(email, entry);
    proc.once("exit", (code, signal) => {
      if (!this.stopping && code !== 0 && signal !== "SIGTERM") {
        logger.warn(
          "Omnigent host for %s exited (%s). Log: %s",
          userId,
          code ?? signal,
          this.logFile(`host-${userId}`),
        );
      }
      if (this.hosts.get(email) === entry) this.hosts.delete(email);
    });
    return entry.ready;
  }

  /** A request to the Omnigent server as `email`. */
  request(
    method: string,
    p: string,
    email: string,
    init: {
      json?: unknown;
      body?: RequestInit["body"];
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    return fetch(this.url + p, {
      method,
      headers: {
        [this.authHeader]: email,
        ...(init.json !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: init.signal,
    });
  }

  status(): OmnigentStatus {
    return {
      ready: Boolean(
        this.server && this.lastError === undefined && this.version,
      ),
      error: this.lastError,
      version: this.version,
      hosts: this.hosts.size,
      gateway: this.gateway?.stats ?? { forwarded: 0, denied: 0 },
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reaper) clearInterval(this.reaper);
    const procs = [
      this.server,
      ...[...this.hosts.values()].map((h) => h.proc),
    ].filter((p): p is ChildProcess => Boolean(p?.pid) && p?.exitCode === null);
    for (const p of procs) killGroup(p, "SIGTERM");
    await Promise.race([
      Promise.all(procs.map((p) => new Promise((r) => p.once("exit", r)))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    for (const p of procs) killGroup(p, "SIGKILL");
    await this.gateway?.stop();
  }

  private reapIdleHosts(): void {
    const cutoff = Date.now() - this.opts.hostIdleMs;
    for (const [email, h] of this.hosts) {
      if (h.lastUsed < cutoff) {
        logger.debug("stopping idle host for %s", h.userId);
        killGroup(h.proc, "SIGTERM");
        this.hosts.delete(email);
      }
    }
  }

  private logFile(name: string): string {
    return path.join(this.layout.logs, `${name}.log`);
  }

  private spawn(
    name: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string = this.layout.root,
  ): ChildProcess {
    const log = fs.openSync(this.logFile(name), "a");
    const child = spawn(argv[0], argv.slice(1), {
      env,
      cwd,
      stdio: ["ignore", log, log],
      detached: true, // own process group, so stop() can take the whole tree down
    });
    fs.closeSync(log);
    child.on("error", (err) => {
      this.lastError = `${name}: ${err.message}`;
      logger.error("failed to start %s: %s", name, err.message);
    });
    return child;
  }

  private async waitFor<T>(
    fn: () => Promise<T | undefined | false>,
    ms: number,
    what: string,
  ): Promise<T> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.stopping) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      `${what} did not come up within ${Math.round(ms / 1000)} s`,
    );
  }
}

function killGroup(p: ChildProcess, signal: NodeJS.Signals): void {
  if (!p.pid) return;
  try {
    process.kill(-p.pid, signal);
  } catch {}
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

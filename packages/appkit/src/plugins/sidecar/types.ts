export interface HealthCheckConfig {
  /** Path for health check HTTP request. Default: "/health" */
  path?: string;
  /** Interval in ms between health checks. Default: 5000 */
  interval?: number;
  /** Timeout in ms for each health check request. Default: 3000 */
  timeout?: number;
  /** Number of consecutive failures before considering unhealthy. Default: 3 */
  unhealthyThreshold?: number;
}

export interface RestartConfig {
  /** Whether to automatically restart on crash. Default: true */
  enabled?: boolean;
  /** Maximum number of restarts before giving up. Default: 5 */
  maxRestarts?: number;
  /** Window in ms to count restarts (resets counter). Default: 60000 */
  restartWindow?: number;
  /** Delay in ms before restarting. Default: 1000 */
  restartDelay?: number;
}

export interface ProxyConfig {
  /** Headers to forward from the incoming request to the sidecar. Default: "all". */
  forwardHeaders?: string[] | "all";
  /** Additional headers to inject into proxied requests. */
  injectHeaders?: Record<string, string>;
  /** Timeout in ms for proxied requests. Default: 30000 */
  timeout?: number;
  /** Base path prefix on the sidecar. Default: "/" */
  basePath?: string;
}

/**
 * Configuration specific to stdio mode.
 *
 * Controls timeouts, concurrency, health checking, and extensibility
 * for the JSON-RPC communication layer. All fields are optional —
 * defaults are tuned for typical ML inference / data processing workloads.
 */
export interface StdioConfig {
  /** Timeout in ms for a single request→response cycle. Default: 30000 */
  requestTimeout?: number;
  /** Interval in ms between ping health checks. Default: 10000 */
  pingInterval?: number;
  /** Max consecutive ping failures before unhealthy. Default: 3 */
  pingFailureThreshold?: number;
  /** Max pending concurrent requests. Default: 50 */
  maxConcurrency?: number;
  /**
   * Callback for custom JSON-RPC notifications from the child process.
   *
   * The bridge handles `ready` and `log` notifications internally.
   * Any other notification method is forwarded to this callback.
   */
  onNotification?: (method: string, params: unknown) => void;
}

/**
 * Per-sidecar definition describing a single child process.
 *
 * Two communication modes are available:
 * - **`"http"` (default):** The child process runs its own HTTP server. AppKit proxies
 *   requests to it. Use this when your sidecar is a web app (Flask, FastAPI, etc.).
 * - **`"stdio"`:** The child process communicates via stdin/stdout using line-delimited
 *   JSON-RPC 2.0. Use this for ML inference, data processing, CLI tools, or background workers.
 */
export interface SidecarDefinition {
  /** Unique identifier for this sidecar. Used for route namespacing (`/api/{id}/*`). */
  id: string;
  /** Communication mode. Default: "http" */
  mode?: "http" | "stdio";

  // --- Shared (both modes) ---
  /** Command to execute (e.g., "python", "ruby", "go"). */
  command: string;
  /** Arguments to the command (e.g., ["-m", "uvicorn", "main:app"]). */
  args?: string[];
  /** Working directory for the child process. Defaults to process.cwd(). */
  cwd?: string;
  /** Additional environment variables passed to the child process. */
  env?: Record<string, string>;
  /** Timeout in ms to wait for child process to become ready during setup(). Default: 30000 */
  startupTimeout?: number;
  /** Process restart configuration. */
  restart?: RestartConfig;
  /** Shell commands to run before spawning the sidecar process. */
  setupCommands?: string[];
  /**
   * When true, setup commands run in a shell (supports pipes, redirects, globbing, etc.).
   * When false or omitted, commands are split on whitespace and executed directly with
   * `execFile` (no shell) — safer against command injection.
   *
   * @default false
   */
  setupShell?: boolean;

  // --- HTTP mode only ---
  /** Port the child process listens on. 0 or omitted for auto-assign. */
  port?: number;
  /** Health check configuration. */
  healthCheck?: HealthCheckConfig;
  /** Proxy configuration. */
  proxy?: ProxyConfig;

  // --- stdio mode only ---
  /** Configuration for stdio mode communication. */
  stdio?: StdioConfig;
}

/**
 * Configuration for the sidecar plugin.
 *
 * Accepts either:
 * - A single {@link SidecarDefinition} object.
 * - An array of {@link SidecarDefinition} entries for multi-sidecar setups.
 */
export type ISidecarConfig = SidecarDefinition | SidecarDefinition[];

export type SidecarStatus =
  | "starting"
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "crashed";

/** Exports for a single sidecar child process. */
export interface SingleSidecarExport {
  /** Current status of the sidecar process. */
  getStatus(): SidecarStatus;
  /** Restart the sidecar process. */
  restart(): Promise<void>;
  /** Stop the sidecar process. */
  stop(): Promise<void>;
  /** Get recent stdout/stderr output lines. */
  getOutput(lines?: number): string[];
  /** The port the sidecar is listening on. Only available in HTTP mode. */
  getPort(): number;
}

/** Public API exported by the sidecar plugin, providing access to all managed sidecars. */
export interface SidecarExport {
  /** Get the export API for a specific sidecar by id. */
  get(id: string): SingleSidecarExport | undefined;
  /** Get all sidecar exports as a Map keyed by id. */
  getAll(): Map<string, SingleSidecarExport>;
  /** Shorthand: get the status of a specific sidecar. */
  getStatus(id: string): SidecarStatus;
  /** Shorthand: restart a specific sidecar. */
  restart(id: string): Promise<void>;
  /** Shorthand: stop a specific sidecar. */
  stop(id: string): Promise<void>;
  /** Shorthand: get recent output lines from a specific sidecar. */
  getOutput(id: string, lines?: number): string[];
  /** Shorthand: get the port for a specific sidecar (HTTP mode only). */
  getPort(id: string): number;
}

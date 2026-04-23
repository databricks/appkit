import { lookup as defaultLookup } from "node:dns/promises";
import { isIP, isIPv4 } from "node:net";

/**
 * DNS lookup function compatible with `dns/promises.lookup(host, { all: true })`.
 * Exposed as an injection point so callers (tests, custom DNS resolvers) can
 * override the default resolver.
 */
export type DnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Policy that decides whether a given MCP endpoint URL is allowed and whether
 * Databricks workspace credentials (SP or OBO) may be forwarded to it.
 *
 * The default posture is zero-trust: only same-origin workspace URLs receive
 * workspace credentials, and all other destinations must be explicitly
 * allowlisted by the application developer. Private / link-local IP ranges
 * are blocked outright to prevent SSRF into cloud metadata services.
 */
export interface McpHostPolicy {
  /** Lowercased hostname of the Databricks workspace (same-origin target). */
  readonly workspaceHostname: string;
  /** Additional allowlisted hostnames (lowercased). Workspace auth is NEVER forwarded to these. */
  readonly trustedHosts: ReadonlySet<string>;
  /** Permit `http://localhost`, `127.0.0.1`, `::1` URLs. Typically true only in development. */
  readonly allowLocalhost: boolean;
}

/**
 * Config shape accepted by {@link buildMcpHostPolicy}, matching the
 * `mcp` field on `AgentsPluginConfig`.
 */
export interface McpHostPolicyConfig {
  /**
   * Additional hostnames that may host custom MCP servers beyond the same-origin
   * workspace. Compared case-insensitively; bare hostnames only (no scheme or
   * path). Workspace credentials (SP / OBO) are never forwarded to these hosts —
   * they must handle authentication themselves.
   */
  trustedHosts?: string[];
  /**
   * Allow `http://localhost`, `127.0.0.1`, and `::1` MCP URLs for local
   * development. Defaults to `true` when `NODE_ENV !== "production"`,
   * otherwise `false`. Workspace credentials are never forwarded to localhost.
   */
  allowLocalhost?: boolean;
}

/** Build an {@link McpHostPolicy} from user config + the resolved workspace URL. */
export function buildMcpHostPolicy(
  config: McpHostPolicyConfig | undefined,
  workspaceHost: string,
): McpHostPolicy {
  const workspaceHostname = safeHostname(workspaceHost);
  if (!workspaceHostname) {
    throw new Error(
      `Invalid workspace host for MCP policy: ${JSON.stringify(workspaceHost)}`,
    );
  }
  const trustedHosts = new Set(
    (config?.trustedHosts ?? []).map((h) => h.trim().toLowerCase()),
  );
  const allowLocalhost =
    config?.allowLocalhost ?? process.env.NODE_ENV !== "production";
  return { workspaceHostname, trustedHosts, allowLocalhost };
}

type McpUrlCheck =
  | {
      readonly ok: true;
      /** Whether it is safe to forward workspace-scoped credentials (SP/OBO) to this URL. */
      readonly forwardWorkspaceAuth: boolean;
      /** Parsed URL for reuse by the caller. */
      readonly url: URL;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Synchronously decide whether an MCP URL is allowed under the given policy
 * and whether workspace credentials may be forwarded to it.
 *
 * Hard rejections:
 * - Non-`http(s)` schemes.
 * - `http://` unless the host is localhost AND `allowLocalhost` is true.
 * - Hosts that are neither same-origin workspace, localhost (if allowed),
 *   nor in `trustedHosts`.
 */
export function checkMcpUrl(
  rawUrl: string,
  policy: McpHostPolicy,
): McpUrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      reason: `MCP URL is not a valid absolute URL: ${rawUrl}`,
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `MCP URL scheme '${url.protocol}' is not allowed (http(s) only): ${rawUrl}`,
    };
  }

  const host = url.hostname.toLowerCase();
  const isLoopback = isLoopbackHost(host);

  if (url.protocol === "http:" && !(isLoopback && policy.allowLocalhost)) {
    return {
      ok: false,
      reason: `MCP URL uses plaintext http:// which forwards bearer tokens in cleartext: ${rawUrl}. Use https:// or enable allowLocalhost for a localhost dev server.`,
    };
  }

  if (host === policy.workspaceHostname) {
    return { ok: true, forwardWorkspaceAuth: true, url };
  }

  if (isLoopback) {
    if (!policy.allowLocalhost) {
      return {
        ok: false,
        reason: `MCP URL points to localhost but allowLocalhost is disabled: ${rawUrl}`,
      };
    }
    return { ok: true, forwardWorkspaceAuth: false, url };
  }

  if (policy.trustedHosts.has(host)) {
    return { ok: true, forwardWorkspaceAuth: false, url };
  }

  return {
    ok: false,
    reason: `MCP host '${host}' is not allowed. Either use a same-origin workspace URL (${policy.workspaceHostname}) or add it to agents({ mcp: { trustedHosts: ['${host}'] } }).`,
  };
}

/**
 * Resolve `hostname` via DNS and assert that none of its addresses fall in a
 * blocked IP range (loopback, RFC1918, link-local, CGNAT, cloud metadata).
 *
 * Throws with a descriptive error if any resolved address is blocked. Pass
 * `allowLocalhost: true` to permit `127.0.0.1` / `::1` specifically.
 *
 * Note: this only guards against hosts that statically resolve to private
 * ranges. Full SSRF protection requires socket-level IP pinning after
 * resolution (DNS rebinding defense), which is out of scope here.
 */
export async function assertResolvedHostSafe(
  hostname: string,
  policy: McpHostPolicy,
  lookup: DnsLookup = defaultLookup,
): Promise<void> {
  const lowered = hostname.toLowerCase();

  if (isIP(lowered)) {
    if (isBlockedIp(lowered, policy.allowLocalhost)) {
      throw new Error(`MCP host ${lowered} is in a blocked IP range`);
    }
    return;
  }

  if (lowered === "localhost") {
    if (!policy.allowLocalhost) {
      throw new Error(
        `MCP host localhost is not allowed under the current policy`,
      );
    }
    return;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch (cause) {
    throw new Error(
      `MCP host ${hostname} could not be resolved via DNS: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (resolved.length === 0) {
    throw new Error(`MCP host ${hostname} returned no DNS addresses`);
  }

  for (const { address } of resolved) {
    if (isBlockedIp(address, policy.allowLocalhost)) {
      throw new Error(
        `MCP host ${hostname} resolved to blocked address ${address} (private / link-local ranges are not allowed)`,
      );
    }
  }
}

/** Whether a raw hostname literal is one of the recognised loopback aliases. */
export function isLoopbackHost(host: string): boolean {
  const lowered = host.toLowerCase();
  return (
    lowered === "localhost" ||
    lowered === "127.0.0.1" ||
    lowered === "::1" ||
    lowered === "[::1]" ||
    lowered === "0:0:0:0:0:0:0:1"
  );
}

/**
 * Check whether a resolved IP address is in a range that should never receive
 * workspace credentials. `allowLocalhost` carves out 127.0.0.0/8 and ::1.
 */
export function isBlockedIp(address: string, allowLocalhost: boolean): boolean {
  if (isIPv4(address)) {
    return isBlockedIpv4(address, allowLocalhost);
  }
  if (isIP(address) === 6) {
    return isBlockedIpv6(address, allowLocalhost);
  }
  // Not a recognisable IP literal — fail-closed.
  return true;
}

function isBlockedIpv4(addr: string, allowLocalhost: boolean): boolean {
  const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 127) return !allowLocalhost;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(addr: string, allowLocalhost: boolean): boolean {
  const lowered = addr.toLowerCase().replace(/^\[|\]$/g, "");

  if (lowered === "::") return true;
  if (lowered === "::1" || lowered === "0:0:0:0:0:0:0:1")
    return !allowLocalhost;

  // IPv4-mapped IPv6: `::ffff:<v4>` may be written in dotted form
  // (`::ffff:169.254.169.254`) or colon-hex form (`::ffff:a9fe:a9fe`). Both
  // route to the same destination, so we must normalise before delegating
  // to the IPv4 blocklist.
  if (lowered.startsWith("::ffff:")) {
    const tail = lowered.slice("::ffff:".length);
    if (isIPv4(tail)) return isBlockedIpv4(tail, allowLocalhost);
    const hexV4 = hexPairToDottedIpv4(tail);
    if (hexV4) return isBlockedIpv4(hexV4, allowLocalhost);
  }

  // Unique Local Addresses (fc00::/7) — `fc` and `fd` only.
  if (/^f[cd][0-9a-f]{2}:/.test(lowered)) return true;
  // Link-local fe80::/10 — the first 10 bits are 1111111010, i.e. the
  // second hex nibble must be 8-b. Matches fe80:..–febf:..
  if (/^fe[89ab][0-9a-f]:/.test(lowered)) return true;
  // Multicast ff00::/8.
  if (lowered.startsWith("ff")) return true;
  return false;
}

/**
 * Parse the trailing two hex groups of an IPv4-mapped IPv6 address written
 * in colon-hex form (e.g. `a9fe:a9fe`) into the equivalent dotted-quad IPv4
 * representation (`169.254.169.254`). Returns null for anything else.
 */
function hexPairToDottedIpv4(tail: string): string | null {
  const match = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const hi = Number.parseInt(match[1], 16);
  const lo = Number.parseInt(match[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  if (hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) return null;
  const a = (hi >> 8) & 0xff;
  const b = hi & 0xff;
  const c = (lo >> 8) & 0xff;
  const d = lo & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function safeHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

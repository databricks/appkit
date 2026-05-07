import { describe, expect, test, vi } from "vitest";
import {
  assertResolvedHostSafe,
  buildMcpHostPolicy,
  checkMcpUrl,
  type DnsLookup,
  isBlockedIp,
  isLoopbackHost,
  type McpHostPolicy,
  type McpHostPolicyConfig,
} from "../tools/mcp-host-policy";

function stubLookup(
  addresses: Array<{ address: string; family?: number }>,
): DnsLookup {
  return vi
    .fn<DnsLookup>()
    .mockResolvedValue(addresses.map((a) => ({ family: 4, ...a })));
}

function failingLookup(message: string): DnsLookup {
  return vi.fn<DnsLookup>().mockRejectedValue(new Error(message));
}

const WORKSPACE = "https://test-workspace.cloud.databricks.com";

function policy(overrides: Partial<McpHostPolicy> = {}): McpHostPolicy {
  return {
    workspaceHostname: "test-workspace.cloud.databricks.com",
    trustedHosts: new Set<string>(),
    allowLocalhost: false,
    ...overrides,
  };
}

describe("buildMcpHostPolicy", () => {
  test("extracts hostname from workspace URL", () => {
    const p = buildMcpHostPolicy(undefined, WORKSPACE);
    expect(p.workspaceHostname).toBe("test-workspace.cloud.databricks.com");
  });

  test("lowercases and trims trustedHosts", () => {
    const p = buildMcpHostPolicy(
      { trustedHosts: ["Example.COM", " corp.internal ", "mcp.example.com"] },
      WORKSPACE,
    );
    expect(p.trustedHosts).toEqual(
      new Set(["example.com", "corp.internal", "mcp.example.com"]),
    );
  });

  test("allowLocalhost defaults to false in production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const p = buildMcpHostPolicy(undefined, WORKSPACE);
      expect(p.allowLocalhost).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test("allowLocalhost defaults to true outside production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const p = buildMcpHostPolicy(undefined, WORKSPACE);
      expect(p.allowLocalhost).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test("allowLocalhost respects explicit override", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const cfg: McpHostPolicyConfig = { allowLocalhost: true };
      const p = buildMcpHostPolicy(cfg, WORKSPACE);
      expect(p.allowLocalhost).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test("throws on invalid workspace host", () => {
    expect(() => buildMcpHostPolicy(undefined, "not-a-url")).toThrow(
      /Invalid workspace host/,
    );
  });
});

describe("checkMcpUrl", () => {
  test("admits same-origin workspace https URL and forwards auth", () => {
    const result = checkMcpUrl(`${WORKSPACE}/api/2.0/mcp/genie/abc`, policy());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.forwardWorkspaceAuth).toBe(true);
  });

  test("admits trusted host but does NOT forward workspace auth", () => {
    const p = policy({ trustedHosts: new Set(["mcp.example.com"]) });
    const result = checkMcpUrl("https://mcp.example.com/mcp", p);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.forwardWorkspaceAuth).toBe(false);
  });

  test("rejects host that is neither workspace nor trusted", () => {
    const result = checkMcpUrl("https://attacker.example.com/mcp", policy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/attacker\.example\.com/);
      expect(result.reason).toMatch(/trustedHosts/);
    }
  });

  test("rejects plaintext http:// for remote hosts even when trusted", () => {
    const p = policy({ trustedHosts: new Set(["mcp.example.com"]) });
    const result = checkMcpUrl("http://mcp.example.com/mcp", p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/plaintext http/);
  });

  test("rejects plaintext http://localhost when allowLocalhost is false", () => {
    const result = checkMcpUrl("http://localhost:4000/mcp", policy());
    expect(result.ok).toBe(false);
  });

  test("admits http://localhost when allowLocalhost is true, no workspace auth", () => {
    const p = policy({ allowLocalhost: true });
    const result = checkMcpUrl("http://localhost:4000/mcp", p);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.forwardWorkspaceAuth).toBe(false);
  });

  test("admits http://127.0.0.1 when allowLocalhost is true", () => {
    const p = policy({ allowLocalhost: true });
    const result = checkMcpUrl("http://127.0.0.1:4000/mcp", p);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.forwardWorkspaceAuth).toBe(false);
  });

  test("rejects non-http(s) schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://host/x",
      "gopher://host/x",
      "javascript:alert(1)",
    ]) {
      const result = checkMcpUrl(url, policy());
      expect(result.ok).toBe(false);
    }
  });

  test("rejects obviously invalid URLs", () => {
    const result = checkMcpUrl("not-a-url", policy());
    expect(result.ok).toBe(false);
  });

  test("hostname comparison is case-insensitive", () => {
    const result = checkMcpUrl(
      "https://TEST-Workspace.CLOUD.Databricks.com/mcp",
      policy(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.forwardWorkspaceAuth).toBe(true);
  });

  test("rejects same hostname on different scheme (http) even for workspace", () => {
    const result = checkMcpUrl(
      "http://test-workspace.cloud.databricks.com/mcp",
      policy(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("isBlockedIp", () => {
  test("blocks RFC1918 IPv4 ranges", () => {
    for (const addr of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
    ]) {
      expect(isBlockedIp(addr, true)).toBe(true);
    }
  });

  test("blocks link-local 169.254.0.0/16 (covers cloud metadata 169.254.169.254)", () => {
    expect(isBlockedIp("169.254.169.254", true)).toBe(true);
    expect(isBlockedIp("169.254.0.1", true)).toBe(true);
  });

  test("blocks CGNAT 100.64.0.0/10", () => {
    expect(isBlockedIp("100.64.0.1", true)).toBe(true);
    expect(isBlockedIp("100.127.255.255", true)).toBe(true);
  });

  test("blocks 0.0.0.0/8 and multicast/reserved (>= 224.0.0.0)", () => {
    expect(isBlockedIp("0.0.0.0", true)).toBe(true);
    expect(isBlockedIp("0.1.2.3", true)).toBe(true);
    expect(isBlockedIp("224.0.0.1", true)).toBe(true);
    expect(isBlockedIp("255.255.255.255", true)).toBe(true);
  });

  test("blocks loopback when allowLocalhost is false", () => {
    expect(isBlockedIp("127.0.0.1", false)).toBe(true);
    expect(isBlockedIp("127.1.2.3", false)).toBe(true);
    expect(isBlockedIp("::1", false)).toBe(true);
  });

  test("permits loopback when allowLocalhost is true", () => {
    expect(isBlockedIp("127.0.0.1", true)).toBe(false);
    expect(isBlockedIp("::1", true)).toBe(false);
  });

  test("blocks ULA (fc00::/7) and link-local (fe80::/10) IPv6", () => {
    expect(isBlockedIp("fc00::1", true)).toBe(true);
    expect(isBlockedIp("fd00::1", true)).toBe(true);
    expect(isBlockedIp("fe80::1", true)).toBe(true);
  });

  test("blocks the full link-local /10 range fe80::–febf:: (regression: fea0/feb0)", () => {
    // fe80::/10 spans 1111 1110 10.. — first hex pair `fe` + second nibble 8..b.
    for (const addr of [
      "fe80::1",
      "fe90::1",
      "fea0::1", // regression: was passing the filter before
      "feaf::1", // regression
      "feb0::1", // regression
      "febf::1", // regression
    ]) {
      expect(isBlockedIp(addr, true)).toBe(true);
    }
    // Outside /10 must not be blocked by this rule (belongs to routable-ish
    // experimental ranges; nothing else in the module should match either).
    expect(isBlockedIp("fec0::1", true)).toBe(false);
  });

  test("blocks IPv4-mapped IPv6 addresses in blocked ranges (dotted form)", () => {
    expect(isBlockedIp("::ffff:169.254.169.254", true)).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1", true)).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 addresses in colon-hex form (regression)", () => {
    // ::ffff:a9fe:a9fe is the same destination as ::ffff:169.254.169.254.
    // Before the fix this form slipped past the IPv4-mapped branch because
    // isIPv4("a9fe:a9fe") is false and no other v6 rule matched.
    expect(isBlockedIp("::ffff:a9fe:a9fe", true)).toBe(true); // 169.254.169.254
    expect(isBlockedIp("::ffff:0a00:0001", true)).toBe(true); // 10.0.0.1
    expect(isBlockedIp("::ffff:c0a8:0001", true)).toBe(true); // 192.168.0.1
    // A public IPv4 mapped to colon-hex must still pass through: 8.8.8.8 = 0808:0808
    expect(isBlockedIp("::ffff:0808:0808", true)).toBe(false);
  });

  test("allows public IPv4 and IPv6 addresses", () => {
    expect(isBlockedIp("8.8.8.8", false)).toBe(false);
    expect(isBlockedIp("1.1.1.1", false)).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888", false)).toBe(false);
  });

  test("treats malformed IP strings as blocked (fail-closed)", () => {
    expect(isBlockedIp("10.0.0", true)).toBe(true);
    expect(isBlockedIp("abc.def.ghi.jkl", true)).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  test.each([
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
  ])("recognises %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test("does not match other hosts", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});

describe("assertResolvedHostSafe", () => {
  test("passes workspace hostname when resolved address is public", async () => {
    const lookup = stubLookup([{ address: "203.0.113.42" }]);
    await expect(
      assertResolvedHostSafe(
        "test-workspace.cloud.databricks.com",
        policy(),
        lookup,
      ),
    ).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("test-workspace.cloud.databricks.com", {
      all: true,
    });
  });

  test("rejects hostname that resolves to link-local cloud metadata IP", async () => {
    const lookup = stubLookup([{ address: "169.254.169.254" }]);
    await expect(
      assertResolvedHostSafe("evil.example.com", policy(), lookup),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  test("rejects hostname that resolves to RFC1918 IP", async () => {
    const lookup = stubLookup([{ address: "10.0.0.1" }]);
    await expect(
      assertResolvedHostSafe("internal.example.com", policy(), lookup),
    ).rejects.toThrow(/10\.0\.0\.1/);
  });

  test("rejects IP literal in blocked range without DNS lookup", async () => {
    const lookup = stubLookup([{ address: "8.8.8.8" }]);
    await expect(
      assertResolvedHostSafe("169.254.169.254", policy(), lookup),
    ).rejects.toThrow(/blocked IP range/);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("rejects plain 'localhost' when allowLocalhost is false", async () => {
    await expect(assertResolvedHostSafe("localhost", policy())).rejects.toThrow(
      /localhost is not allowed/,
    );
  });

  test("surfaces DNS resolution failures", async () => {
    const lookup = failingLookup("ENOTFOUND");
    await expect(
      assertResolvedHostSafe("nonexistent.example.com", policy(), lookup),
    ).rejects.toThrow(/could not be resolved/);
  });

  test("rejects if any resolved address is blocked (defense against split DNS)", async () => {
    const lookup = stubLookup([
      { address: "8.8.8.8" },
      { address: "169.254.169.254" },
    ]);
    await expect(
      assertResolvedHostSafe("mixed.example.com", policy(), lookup),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  test("rejects hostname that resolves to empty DNS result", async () => {
    const lookup = stubLookup([]);
    await expect(
      assertResolvedHostSafe("empty.example.com", policy(), lookup),
    ).rejects.toThrow(/no DNS addresses/);
  });
});

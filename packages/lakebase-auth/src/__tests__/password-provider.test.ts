import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createPasswordProvider,
  DEFAULT_EARLY_REFRESH_MS,
} from "../password-provider";
import type { Credential } from "../types";

// Spy on the credential generation and workspace-client creation so the default
// fetcher can be exercised without any network or SDK auth.
vi.mock("../credentials", () => ({
  generateDatabaseCredential: vi.fn(),
}));
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, getWorkspaceClient: vi.fn() };
});

import { getWorkspaceClient } from "../config";
import { generateDatabaseCredential } from "../credentials";

const HOUR = 3_600_000;

const mockGenerate = vi.mocked(generateDatabaseCredential);
const mockGetWorkspaceClient = vi.mocked(getWorkspaceClient);

describe("createPasswordProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("exposes the documented default early-refresh buffer", () => {
    expect(DEFAULT_EARLY_REFRESH_MS).toBe(120_000);
  });

  test("eager mode (default) fetches a token immediately", async () => {
    const fetchCredential = vi.fn(
      async (): Promise<Credential> => ({
        token: "eager-token",
        expiresAt: Date.now() + HOUR,
      }),
    );

    const provider = createPasswordProvider({ fetchCredential });
    await vi.advanceTimersByTimeAsync(0); // flush the eager initial fetch

    expect(fetchCredential).toHaveBeenCalledTimes(1);
    await expect(provider.password()).resolves.toBe("eager-token");
    expect(fetchCredential).toHaveBeenCalledTimes(1); // served from cache

    provider.dispose();
  });

  test("lazy mode defers fetching until the password is requested", async () => {
    const fetchCredential = vi.fn(
      async (): Promise<Credential> => ({
        token: "lazy-token",
        expiresAt: Date.now() + HOUR,
      }),
    );

    const provider = createPasswordProvider({ fetchCredential, mode: "lazy" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCredential).not.toHaveBeenCalled();

    await expect(provider.password()).resolves.toBe("lazy-token");
    expect(fetchCredential).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  test("dispose stops eager background refreshes", async () => {
    const fetchCredential = vi.fn(
      async (): Promise<Credential> => ({
        token: "t",
        // Short-lived so a background refresh would be scheduled soon.
        expiresAt: Date.now() + 200_000,
      }),
    );

    const provider = createPasswordProvider({
      fetchCredential,
      earlyRefreshMs: 120_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCredential).toHaveBeenCalledTimes(1);

    provider.dispose();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchCredential).toHaveBeenCalledTimes(1); // no further refresh

    expect(() => provider.dispose()).not.toThrow(); // idempotent
  });

  test("applies the retry schedule and logs retries on failure", async () => {
    const fetchCredential = vi
      .fn<() => Promise<Credential>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({
        token: "after-retry",
        expiresAt: Date.now() + HOUR,
      });
    const onLog = vi.fn();

    const provider = createPasswordProvider({
      fetchCredential,
      mode: "lazy",
      retry: { schedule: [10] },
      onLog,
    });

    const pending = provider.password();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("after-retry");

    expect(fetchCredential).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Retrying"),
      10,
      expect.stringContaining("transient"),
    );

    provider.dispose();
  });

  test("an empty retry schedule disables retries", async () => {
    const fetchCredential = vi
      .fn<() => Promise<Credential>>()
      .mockRejectedValue(new Error("boom"));

    const provider = createPasswordProvider({
      fetchCredential,
      mode: "lazy",
      retry: { schedule: [] },
    });

    await expect(provider.password()).rejects.toThrow("boom");
    expect(fetchCredential).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  describe("default SDK-based fetcher", () => {
    test("throws when no endpoint is provided", () => {
      expect(() => createPasswordProvider({ mode: "lazy" })).toThrow(
        "config.endpoint",
      );
    });

    test("uses a provided workspace client, forwarding claims and mapping expiry", async () => {
      const expireTime = "2099-01-01T00:00:00Z";
      mockGenerate.mockResolvedValue({
        token: "sdk-token",
        expire_time: expireTime,
      });
      const workspaceClient = { config: { host: "test" } } as never;
      const claims = [{ permission_set: undefined, resources: [] }];

      const provider = createPasswordProvider({
        mode: "lazy",
        endpoint: "projects/p/branches/b/endpoints/e",
        workspaceClient,
        claims,
      });

      await expect(provider.password()).resolves.toBe("sdk-token");
      expect(mockGetWorkspaceClient).not.toHaveBeenCalled();
      expect(mockGenerate).toHaveBeenCalledWith(workspaceClient, {
        endpoint: "projects/p/branches/b/endpoints/e",
        claims,
      });

      provider.dispose();
    });

    test("lazily creates a workspace client when none is provided", async () => {
      const createdClient = { config: { host: "auto" } };
      mockGetWorkspaceClient.mockReturnValue(createdClient as never);
      mockGenerate.mockResolvedValue({
        token: "auto-token",
        expire_time: "2099-01-01T00:00:00Z",
      });

      const provider = createPasswordProvider({
        mode: "lazy",
        endpoint: "projects/p/branches/b/endpoints/e",
      });

      await expect(provider.password()).resolves.toBe("auto-token");
      expect(mockGetWorkspaceClient).toHaveBeenCalledTimes(1);
      // No claims provided -> payload omits the claims key entirely.
      expect(mockGenerate).toHaveBeenCalledWith(createdClient, {
        endpoint: "projects/p/branches/b/endpoints/e",
      });

      // The client is created once and reused across fetches.
      await provider.password();
      expect(mockGetWorkspaceClient).toHaveBeenCalledTimes(1);

      provider.dispose();
    });
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cachedWithOnDemandRefresh, cachedWithTimedRefresh } from "../caching";
import type { Credential } from "../types";

const HOUR = 3_600_000;
const EARLY = 120_000;

describe("cachedWithTimedRefresh (eager)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("fetches immediately on creation and serves the cached token", async () => {
    const fetch = vi.fn(
      async (): Promise<Credential> => ({
        token: "t1",
        expiresAt: Date.now() + HOUR,
      }),
    );

    const provider = cachedWithTimedRefresh(fetch, EARLY);
    await vi.advanceTimersByTimeAsync(0); // flush the eager initial fetch

    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(provider.getToken()).resolves.toBe("t1");
    expect(fetch).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  test("refreshes in the background before the token expires", async () => {
    let n = 0;
    const fetch = vi.fn(async (): Promise<Credential> => {
      n += 1;
      return { token: `t${n}`, expiresAt: Date.now() + 200_000 };
    });

    const provider = cachedWithTimedRefresh(fetch, EARLY);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Scheduled refresh fires 200s - 120s = 80s after the fetch.
    await vi.advanceTimersByTimeAsync(80_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(provider.getToken()).resolves.toBe("t2");

    provider.dispose();
  });

  test("retries a failed background refresh", async () => {
    const fetch = vi
      .fn<() => Promise<Credential>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ token: "t-ok", expiresAt: Date.now() + HOUR });
    const onLog = vi.fn();

    const provider = cachedWithTimedRefresh(fetch, EARLY, onLog);
    await vi.advanceTimersByTimeAsync(0); // initial attempt fails
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalled();

    // BACKGROUND_RETRY_MS is 5000ms.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(provider.getToken()).resolves.toBe("t-ok");

    provider.dispose();
  });

  test("dispose stops further background refreshes", async () => {
    const fetch = vi.fn(
      async (): Promise<Credential> => ({
        token: "t",
        expiresAt: Date.now() + 200_000,
      }),
    );

    const provider = cachedWithTimedRefresh(fetch, EARLY);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    provider.dispose();
    await vi.advanceTimersByTimeAsync(200_000);
    // No further fetches after disposal.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("cachedWithOnDemandRefresh (lazy)", () => {
  test("does not fetch until first use, then caches", async () => {
    const fetch = vi.fn(
      async (): Promise<Credential> => ({
        token: "t1",
        expiresAt: Date.now() + HOUR,
      }),
    );

    const provider = cachedWithOnDemandRefresh(fetch, EARLY);
    expect(fetch).not.toHaveBeenCalled();

    await expect(provider.getToken()).resolves.toBe("t1");
    await expect(provider.getToken()).resolves.toBe("t1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("deduplicates concurrent refreshes", async () => {
    let resolveFetch: (c: Credential) => void = () => {};
    const fetch = vi.fn(
      (): Promise<Credential> =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const provider = cachedWithOnDemandRefresh(fetch, EARLY);
    const p1 = provider.getToken();
    const p2 = provider.getToken();
    const p3 = provider.getToken();

    resolveFetch({ token: "t1", expiresAt: Date.now() + HOUR });

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
      "t1",
      "t1",
      "t1",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("refreshes on demand when the token nears expiry", async () => {
    let n = 0;
    const fetch = vi.fn(async (): Promise<Credential> => {
      n += 1;
      // Expires within the early-refresh buffer, so the next call must refresh.
      return { token: `t${n}`, expiresAt: Date.now() + 100 };
    });

    const provider = cachedWithOnDemandRefresh(fetch, EARLY);
    await expect(provider.getToken()).resolves.toBe("t1");
    await expect(provider.getToken()).resolves.toBe("t2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("retries after a failed refresh instead of caching the rejection", async () => {
    const fetch = vi
      .fn<() => Promise<Credential>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ token: "t-ok", expiresAt: Date.now() + HOUR });

    const provider = cachedWithOnDemandRefresh(fetch, EARLY);
    await expect(provider.getToken()).rejects.toThrow("boom");
    await expect(provider.getToken()).resolves.toBe("t-ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

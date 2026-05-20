import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useSubmitApproval } from "./use-submit-approval";

const API = "/api/agents/approve";

const DECISION = {
  approvalId: "appr-1",
  streamId: "stream-1",
  decision: "approve" as const,
};

describe("useSubmitApproval", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("does not call fetch on mount", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderHook(() => useSubmitApproval({ api: API }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("POSTs the decision body as JSON", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useSubmitApproval({ api: API }));

    await act(async () => {
      await result.current.submit(DECISION);
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      API,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify({
          streamId: DECISION.streamId,
          approvalId: DECISION.approvalId,
          decision: DECISION.decision,
        }),
      }),
    );
  });

  test("toggles loading + error around a successful call", async () => {
    const { result } = renderHook(() => useSubmitApproval({ api: API }));

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.submit(DECISION);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("rejects + surfaces server error on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Stream gone" }), { status: 410 }),
    );

    const { result } = renderHook(() => useSubmitApproval({ api: API }));

    await act(async () => {
      await expect(result.current.submit(DECISION)).rejects.toThrow(
        "Stream gone",
      );
    });

    expect(result.current.error?.message).toBe("Stream gone");
    expect(result.current.loading).toBe(false);
  });

  test("falls back to HTTP status when error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );

    const { result } = renderHook(() => useSubmitApproval({ api: API }));

    await act(async () => {
      await expect(result.current.submit(DECISION)).rejects.toThrow("HTTP 500");
    });
  });

  test("forwards extra headers from options", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() =>
      useSubmitApproval({ api: API, headers: { "X-Token": "abc" } }),
    );

    await act(async () => {
      await result.current.submit(DECISION);
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      API,
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Token": "abc" }),
      }),
    );
  });

  test("clears error on the next successful call", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Boom" }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const { result } = renderHook(() => useSubmitApproval({ api: API }));

    await act(async () => {
      await expect(result.current.submit(DECISION)).rejects.toThrow("Boom");
    });
    expect(result.current.error?.message).toBe("Boom");

    await act(async () => {
      await result.current.submit(DECISION);
    });
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

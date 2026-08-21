import { describe, expect, it, vi } from "vitest";

import { Context } from "../../workspace-client";
import { contextFromAbortSignal } from "../context";

describe("contextFromAbortSignal", () => {
  it("returns undefined when no signal is given", () => {
    expect(contextFromAbortSignal()).toBeUndefined();
  });

  it("wraps a signal in an SDK Context", () => {
    const ctx = contextFromAbortSignal(new AbortController().signal);
    expect(ctx).toBeInstanceOf(Context);
    expect(ctx?.cancellationToken).toBeDefined();
  });

  it("reflects the signal's aborted state via isCancellationRequested", () => {
    const controller = new AbortController();
    const token = contextFromAbortSignal(controller.signal)?.cancellationToken;

    expect(token?.isCancellationRequested).toBe(false);
    controller.abort();
    expect(token?.isCancellationRequested).toBe(true);
  });

  it("fires registered callbacks when the signal aborts", () => {
    const controller = new AbortController();
    const token = contextFromAbortSignal(controller.signal)?.cancellationToken;

    const cb = vi.fn();
    token?.onCancellationRequested(cb);
    expect(cb).not.toHaveBeenCalled();

    controller.abort();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires immediately when registering on an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    const token = contextFromAbortSignal(controller.signal)?.cancellationToken;

    const cb = vi.fn();
    token?.onCancellationRequested(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("isolates callback failures so abort stays best-effort", () => {
    const controller = new AbortController();
    const token = contextFromAbortSignal(controller.signal)?.cancellationToken;

    const bad = vi.fn(() => {
      throw new Error("listener boom");
    });
    const good = vi.fn();
    token?.onCancellationRequested(bad);
    token?.onCancellationRequested(good);

    expect(() => controller.abort()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

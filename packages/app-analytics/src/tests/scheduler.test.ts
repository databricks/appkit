import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeliveryScheduler, FLUSH_INTERVAL_MS } from "../core/scheduler";

const schedulers = new Set<DeliveryScheduler>();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const scheduler of schedulers) scheduler.stop();
  schedulers.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DeliveryScheduler", () => {
  it("uses one non-debounced five-second timer", () => {
    const onFlush = vi.fn();
    const scheduler = createScheduler(onFlush);

    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(4_000);

    // Scheduling more work must not postpone the timer started by the first item.
    scheduler.schedule();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS - 4_001);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenLastCalledWith("interval");

    scheduler.schedule();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith("interval");
  });

  it("cancels scheduled work and can schedule again", () => {
    const onFlush = vi.fn();
    const scheduler = createScheduler(onFlush);

    scheduler.schedule();
    scheduler.cancel();
    scheduler.cancel();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(onFlush).not.toHaveBeenCalled();

    scheduler.schedule();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(onFlush).toHaveBeenCalledOnce();
    expect(onFlush).toHaveBeenCalledWith("interval");
  });

  it("coalesces hidden signals and rearms after pageshow or visibility", () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    const onFlush = vi.fn();
    const scheduler = createScheduler(onFlush);

    scheduler.start();
    scheduler.start();
    scheduler.schedule();

    window.dispatchEvent(new Event("pagehide"));
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onFlush.mock.calls).toEqual([["pagehide"]]);

    window.dispatchEvent(new Event("pageshow"));
    scheduler.schedule();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onFlush.mock.calls).toEqual([["pagehide"], ["pagehide"]]);

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    scheduler.schedule();
    window.dispatchEvent(new Event("pagehide"));
    expect(onFlush.mock.calls).toEqual([
      ["pagehide"],
      ["pagehide"],
      ["pagehide"],
    ]);

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(onFlush).toHaveBeenCalledTimes(3);
  });

  it("allows the final pagehide after an earlier hidden signal", () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    const onFlush = vi.fn();
    const scheduler = createScheduler(onFlush);

    scheduler.start();
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));

    expect(onFlush.mock.calls).toEqual([["pagehide"], ["pagehide"]]);
  });

  it("removes lifecycle hooks and pending timers when stopped", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const onFlush = vi.fn();
    const scheduler = createScheduler(onFlush);

    scheduler.start();
    scheduler.schedule();
    scheduler.stop();
    scheduler.stop();

    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(onFlush).not.toHaveBeenCalled();
  });
});

function createScheduler(
  onFlush: ConstructorParameters<typeof DeliveryScheduler>[0],
): DeliveryScheduler {
  const scheduler = new DeliveryScheduler(onFlush);
  schedulers.add(scheduler);
  return scheduler;
}

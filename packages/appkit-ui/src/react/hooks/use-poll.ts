import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Configuration options for the polling scheduler.
 */
interface UsePollOptions {
  /**
   * Interval between ticks in milliseconds. Default: 1000.
   */
  intervalMs?: number;

  /**
   * If true (default), fire once at t=0 before entering the interval cadence.
   */
  immediate?: boolean;

  /**
   * Exponential backoff configuration. Default backoff is 1→2→4→8→8… seconds,
   * capped at 8 seconds. On every error, the scheduler backs off and ticks
   * are skipped until the backoff deadline is reached, then the next real
   * attempt fires.
   *
   * By default, backoff is infinite (no maxBackoff). Set to a value to cap it.
   */
  backoff?: {
    /**
     * Base backoff in milliseconds. Default: 1000.
     */
    baseMs?: number;
    /**
     * Exponential multiplier. Default: 2.
     */
    multiplier?: number;
    /**
     * Maximum backoff in milliseconds. Default: 8000.
     */
    maxMs?: number;
  };

  /**
   * Pause the scheduler after this many consecutive errors. If unset,
   * the scheduler retries indefinitely. When this threshold is reached,
   * the scheduler pauses (stops ticking).
   */
  maxConsecutiveErrors?: number;
}

/**
 * Result of the polling scheduler, including telemetry and controls.
 */
interface UsePollResult {
  /**
   * True if the scheduler is paused (no ticking, no pending timer).
   */
  paused: boolean;

  /**
   * Pause the scheduler. No more ticks will fire until resume() is called.
   */
  pause: () => void;

  /**
   * Resume the scheduler. Polls immediately, then resumes the interval cadence.
   */
  resume: () => void;

  /**
   * Restart the scheduler. Clears all telemetry, backoff state, and in-flight
   * tracking but does NOT auto-terminate. The scheduler will not fire again
   * unless resume() or refetch() is called.
   */
  restart: () => void;

  /**
   * Trigger an out-of-band run immediately, ignoring the interval and backoff
   * state. If a run is already in-flight, this is skipped (increments skipped).
   */
  refetch: () => void;

  /**
   * Total number of completed (settled) attempts.
   */
  attempts: number;

  /**
   * Total number of errors (settled with an exception).
   */
  errors: number;

  /**
   * Total number of ticks that were skipped because a run was already in-flight.
   */
  skipped: number;

  /**
   * Current count of consecutive errors. Resets to 0 on a successful run.
   */
  consecutiveErrors: number;

  /**
   * Latency (in milliseconds) of the most recently settled run, or null if
   * no runs have settled yet.
   */
  lastLatencyMs: number | null;

  /**
   * Latency percentiles computed over all settled runs.
   */
  latency: {
    /** 50th percentile (median) latency, or null if no runs have settled. */
    p50: number | null;
    /** 95th percentile latency, or null if fewer than 20 samples exist. */
    p95: number | null;
  };
}

/**
 * Transport-agnostic polling scheduler. Drives an arbitrary async "run once"
 * action with interval ticking, exponential backoff, and telemetry.
 *
 * The scheduler knows nothing about analytics, cursors, rows, SSE, or "done";
 * it only manages timing and state. App logic determines when to call pause(),
 * resume(), restart(), or terminate.
 *
 * @internal Not exported from the public API.
 */
export function usePoll(
  runOnce: () => Promise<void>,
  options: UsePollOptions = {},
): UsePollResult {
  const {
    intervalMs = 1000,
    immediate = true,
    backoff: backoffOpts = {},
    maxConsecutiveErrors,
  } = options;

  const {
    baseMs: backoffBaseMs = 1000,
    multiplier: backoffMultiplier = 2,
    maxMs: backoffMaxMs = 8000,
  } = backoffOpts;

  // === State ===
  const [paused, setPaused] = useState(!immediate);
  const [telemetry, setTelemetry] = useState({
    attempts: 0,
    errors: 0,
    skipped: 0,
    consecutiveErrors: 0,
    latencies: [] as number[],
    lastLatencyMs: null as number | null,
  });

  // Scheduler state refs.
  const schedulerRef = useRef({
    timerHandle: null as ReturnType<typeof setTimeout> | null,
    inFlightAbort: null as AbortController | null,
    backoffDeadline: 0,
    backoffLevel: 0, // 0 = no backoff, 1 = 1s, 2 = 2s, etc.
  });

  /**
   * Compute latency percentiles from settled samples.
   */
  const computeLatencyPercentiles = useCallback(
    (samples: number[]): { p50: number | null; p95: number | null } => {
      if (samples.length === 0) {
        return { p50: null, p95: null };
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 =
        sorted.length < 20 ? null : sorted[Math.floor(sorted.length * 0.95)];
      return { p50, p95 };
    },
    [],
  );

  /**
   * Execute the action, measure latency, and update telemetry.
   */
  const executeRun = useCallback(async () => {
    const abort = new AbortController();
    schedulerRef.current.inFlightAbort = abort;

    try {
      const start = performance.now();
      await runOnce();
      const latency = performance.now() - start;

      // Success: record telemetry.
      setTelemetry((prev) => {
        const newLatencies = [...prev.latencies, latency];
        return {
          ...prev,
          attempts: prev.attempts + 1,
          consecutiveErrors: 0,
          lastLatencyMs: latency,
          latencies: newLatencies,
        };
      });

      // Reset backoff on success.
      schedulerRef.current.backoffLevel = 0;
      schedulerRef.current.backoffDeadline = 0;
    } catch {
      // Error: record telemetry and advance backoff.
      setTelemetry((prev) => {
        const newConsecutiveErrors = prev.consecutiveErrors + 1;

        // Check if we should pause due to maxConsecutiveErrors.
        if (
          maxConsecutiveErrors &&
          newConsecutiveErrors >= maxConsecutiveErrors
        ) {
          setPaused(true);
        }

        return {
          ...prev,
          attempts: prev.attempts + 1,
          errors: prev.errors + 1,
          consecutiveErrors: newConsecutiveErrors,
          latencies: prev.latencies, // No latency added on error.
        };
      });

      // Advance backoff: 1, 2, 4, 8, 8, 8, ...
      const scheduler = schedulerRef.current;
      scheduler.backoffLevel = Math.min(
        scheduler.backoffLevel + 1,
        Math.ceil(Math.log2(backoffMaxMs / backoffBaseMs)),
      );
      const backoffMs = Math.min(
        backoffBaseMs * Math.pow(backoffMultiplier, scheduler.backoffLevel - 1),
        backoffMaxMs,
      );
      scheduler.backoffDeadline = Date.now() + backoffMs;
    } finally {
      schedulerRef.current.inFlightAbort = null;
    }
  }, [
    runOnce,
    maxConsecutiveErrors,
    backoffBaseMs,
    backoffMaxMs,
    backoffMultiplier,
  ]);

  /**
   * Execute the next tick of the polling scheduler.
   */
  const executeTick = useCallback(() => {
    const scheduler = schedulerRef.current;
    const inFlight = scheduler.inFlightAbort !== null;

    if (inFlight) {
      // Tick arrived while a run is in-flight: skip it.
      setTelemetry((prev) => ({ ...prev, skipped: prev.skipped + 1 }));
      return;
    }

    // Check if we're in backoff and the deadline hasn't passed yet.
    const now = Date.now();
    if (scheduler.backoffDeadline > now) {
      // Still backing off: skip this tick but stay ticking.
      setTelemetry((prev) => ({ ...prev, skipped: prev.skipped + 1 }));
      return;
    }

    // Ready to execute.
    void executeRun();
  }, [executeRun]);

  /**
   * Set up the interval timer. Assumes the scheduler is not paused.
   */
  const startTicking = useCallback(() => {
    const scheduler = schedulerRef.current;
    if (scheduler.timerHandle !== null) {
      return; // Already ticking.
    }
    scheduler.timerHandle = setInterval(executeTick, intervalMs);
  }, [intervalMs, executeTick]);

  /**
   * Clear the interval timer.
   */
  const stopTicking = useCallback(() => {
    const scheduler = schedulerRef.current;
    if (scheduler.timerHandle !== null) {
      clearInterval(scheduler.timerHandle);
      scheduler.timerHandle = null;
    }
  }, []);

  // === Controls ===

  const pause = useCallback(() => {
    setPaused(true);
    stopTicking();
  }, [stopTicking]);

  const resume = useCallback(() => {
    setPaused(false);
    // Poll immediately, then ticking will start in the effect.
    void executeRun();
  }, [executeRun]);

  const restart = useCallback(() => {
    // Stop ticking and clear backoff/in-flight state.
    stopTicking();
    const scheduler = schedulerRef.current;
    scheduler.backoffDeadline = 0;
    scheduler.backoffLevel = 0;
    scheduler.inFlightAbort = null;
    // Clear telemetry.
    setTelemetry({
      attempts: 0,
      errors: 0,
      skipped: 0,
      consecutiveErrors: 0,
      latencies: [],
      lastLatencyMs: null,
    });
    // Don't unpause or resume ticking; that's app logic.
  }, [stopTicking]);

  const refetch = useCallback(() => {
    // Out-of-band run: ignore interval and backoff. If a run is in-flight, skip.
    const scheduler = schedulerRef.current;
    if (scheduler.inFlightAbort !== null) {
      setTelemetry((prev) => ({ ...prev, skipped: prev.skipped + 1 }));
      return;
    }
    void executeRun();
  }, [executeRun]);

  // === Lifecycle ===

  // On mount, fire immediate tick if requested.
  useEffect(() => {
    if (immediate && !paused) {
      void executeRun();
      startTicking();
    }
  }, [immediate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop ticking based on paused state.
  useEffect(() => {
    if (!paused && schedulerRef.current.timerHandle === null) {
      startTicking();
    } else if (paused) {
      stopTicking();
    }
    return () => {
      stopTicking();
    };
  }, [paused, startTicking, stopTicking]);

  // === Return ===

  return {
    paused,
    pause,
    resume,
    restart,
    refetch,
    attempts: telemetry.attempts,
    errors: telemetry.errors,
    skipped: telemetry.skipped,
    consecutiveErrors: telemetry.consecutiveErrors,
    lastLatencyMs: telemetry.lastLatencyMs,
    latency: computeLatencyPercentiles(telemetry.latencies),
  };
}

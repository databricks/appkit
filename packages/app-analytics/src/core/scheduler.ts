export const FLUSH_INTERVAL_MS = 5_000;

type FlushReason = "interval" | "pagehide";
type FlushListener = (reason: FlushReason) => void;

/** Owns the browser lifecycle hooks and the single queue flush timer. */
export class DeliveryScheduler {
  private pageHidden = false;
  private listening = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onFlush: FlushListener) {}

  get isPageHidden(): boolean {
    return this.pageHidden;
  }

  start(): void {
    if (
      this.listening ||
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function"
    ) {
      return;
    }

    try {
      this.pageHidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      window.addEventListener("pagehide", this.handlePageHide);
      window.addEventListener("pageshow", this.handlePageShow);
      if (
        typeof document !== "undefined" &&
        typeof document.addEventListener === "function"
      ) {
        document.addEventListener(
          "visibilitychange",
          this.handleVisibilityChange,
        );
      }
      this.listening = true;
    } catch {
      this.pageHidden = false;
      this.removeLifecycleListeners();
    }
  }

  schedule(): void {
    if (this.timer !== undefined) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.safelyNotify("interval");
    }, FLUSH_INTERVAL_MS);
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.cancel();
    this.pageHidden = false;
    if (!this.listening) return;
    this.listening = false;
    this.removeLifecycleListeners();
  }

  private readonly handlePageHide = (): void => {
    this.pageHidden = true;
    this.notifyPageHidden();
  };

  private notifyPageHidden(): void {
    this.cancel();
    this.safelyNotify("pagehide");
  }

  private readonly handlePageShow = (): void => {
    this.pageHidden = false;
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      if (this.pageHidden) return;
      this.pageHidden = true;
      this.notifyPageHidden();
    } else {
      this.handlePageShow();
    }
  };

  private safelyNotify(reason: FlushReason): void {
    try {
      this.onFlush(reason);
    } catch {
      // Browser lifecycle instrumentation must not affect the host page.
    }
  }

  private removeLifecycleListeners(): void {
    try {
      if (typeof window !== "undefined") {
        window.removeEventListener?.("pagehide", this.handlePageHide);
      }
    } catch {
      // Continue removing the other independently installed hooks.
    }
    try {
      if (typeof window !== "undefined") {
        window.removeEventListener?.("pageshow", this.handlePageShow);
      }
    } catch {
      // Continue removing the other independently installed hooks.
    }
    try {
      if (typeof document !== "undefined") {
        document.removeEventListener?.(
          "visibilitychange",
          this.handleVisibilityChange,
        );
      }
    } catch {
      // A locked host document must not make shutdown fail.
    }
  }
}

/**
 * An on/off browser observer. `start` installs it and returns its disposer,
 * or undefined when it cannot run in this environment. Turning it on twice
 * installs it once.
 */
export class Instrumentation {
  private dispose: (() => void) | undefined;

  constructor(private readonly start: () => (() => void) | undefined) {}

  set(enabled: boolean): void {
    if (enabled) {
      this.enable();
    } else {
      this.disable();
    }
  }

  disable(): void {
    const dispose = this.dispose;
    this.dispose = undefined;
    dispose?.();
  }

  private enable(): void {
    if (this.dispose !== undefined) return;
    try {
      this.dispose = this.start();
    } catch {
      // Browser instrumentation must not affect application initialization.
    }
  }
}

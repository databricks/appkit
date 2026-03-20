/// <reference lib="dom" />

const MAX_ENTRIES = 30;

export type ConsoleLevel = "log" | "info" | "warn" | "error";

export interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;
  timestamp: string;
  stack?: string;
}

export interface ConsoleState {
  recentEntries: ConsoleEntry[];
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === "object" && arg !== null) {
        try {
          return JSON.stringify(arg).slice(0, 300);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ")
    .slice(0, 500);
}

export function interceptConsole(): ConsoleState {
  const state: ConsoleState = { recentEntries: [] };

  const push = (entry: ConsoleEntry) => {
    state.recentEntries.unshift(entry);
    if (state.recentEntries.length > MAX_ENTRIES) {
      state.recentEntries.length = MAX_ENTRIES;
    }
  };

  if ((window as any).__APPKIT_INSPECTOR_CONSOLE_PATCHED__) return state;
  (window as any).__APPKIT_INSPECTOR_CONSOLE_PATCHED__ = true;

  const levels: ConsoleLevel[] = ["log", "info", "warn", "error"];

  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const message = formatArgs(args);
      if (message.startsWith("[appkit-inspector]")) {
        original(...args);
        return;
      }
      push({
        level,
        message,
        timestamp: new Date().toISOString(),
        stack:
          level === "error"
            ? new Error().stack?.split("\n").slice(2, 5).join("\n")
            : undefined,
      });
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    push({
      level: "error",
      message: `Uncaught: ${event.message || "Unknown error"}`,
      timestamp: new Date().toISOString(),
      stack: event.error?.stack?.split("\n").slice(0, 5).join("\n"),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? `Unhandled rejection: ${reason.message}`
        : `Unhandled rejection: ${String(reason).slice(0, 300)}`;
    push({
      level: "error",
      message,
      timestamp: new Date().toISOString(),
      stack:
        reason instanceof Error
          ? reason.stack?.split("\n").slice(0, 5).join("\n")
          : undefined,
    });
  });

  return state;
}

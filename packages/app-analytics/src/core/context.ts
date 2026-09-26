import { SDK_NAME, SDK_VERSION, type EventContext } from "./event";

export const MAX_PAGE_PATH_BYTES = 2 * 1_024;
export const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
const SESSION_STORAGE_KEY = "databricks.app.analytics.session.v1";

const IN_MEMORY_SESSION_KEY = Symbol.for(
  "@databricks/app-analytics/session-v1",
);

interface BrowserLocation {
  href: string;
  pathname: string;
}

interface SessionState {
  id: string;
  lastActivityAt: number;
}

export function createEventId(): string {
  return createRandomId();
}

export function getOrCreateSessionId(now = Date.now()): string {
  const storage = readSessionStorage();
  const previous = newestSession(
    readInMemorySession(),
    storage === undefined ? undefined : readStoredSession(storage),
  );
  const state = isActiveSession(previous, now)
    ? previous
    : { id: createRandomId(), lastActivityAt: now };

  writeInMemorySession(state);
  if (storage !== undefined) writeStoredSession(storage, state);
  return state.id;
}

export function markSessionActivity(sessionId: string, now: number): void {
  if (!Number.isFinite(now)) return;

  const storage = readSessionStorage();
  const current = newestSession(
    readInMemorySession(),
    storage === undefined ? undefined : readStoredSession(storage),
  );
  if (current?.id !== sessionId) return;

  const state = { id: sessionId, lastActivityAt: now };
  writeInMemorySession(state);
  if (storage !== undefined) writeStoredSession(storage, state);
}

export function createEventContext(sessionId: string): EventContext {
  return {
    sessionId,
    path: readPageLocation().path,
    sdkName: SDK_NAME,
    sdkVersion: SDK_VERSION,
  };
}

export function readPageLocation(): Pick<EventContext, "path"> {
  return sanitizePageLocation(readBrowserLocation());
}

export function sanitizePageLocation(
  location: BrowserLocation | undefined,
): Pick<EventContext, "path"> {
  if (location === undefined) return { path: "" };

  try {
    const url = new URL(location.href);
    return { path: keepWithinByteLimit(url.pathname, MAX_PAGE_PATH_BYTES) };
  } catch {
    return {
      path: keepWithinByteLimit(location.pathname, MAX_PAGE_PATH_BYTES),
    };
  }
}

function readBrowserLocation(): BrowserLocation | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location;
}

function readSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readStoredSession(storage: Storage): SessionState | undefined {
  try {
    const value = storage.getItem(SESSION_STORAGE_KEY);
    if (value === null) return undefined;
    return parseSessionState(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function writeStoredSession(storage: Storage, state: SessionState): void {
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The in-memory state remains authoritative when storage is not writable.
  }
}

function readInMemorySession(): SessionState | undefined {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  return parseSessionState(registry[IN_MEMORY_SESSION_KEY]);
}

function writeInMemorySession(state: SessionState): void {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  registry[IN_MEMORY_SESSION_KEY] = state;
}

function parseSessionState(value: unknown): SessionState | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const state = value as Partial<SessionState>;
  return typeof state.id === "string" &&
    state.id.length > 0 &&
    typeof state.lastActivityAt === "number" &&
    Number.isFinite(state.lastActivityAt)
    ? { id: state.id, lastActivityAt: state.lastActivityAt }
    : undefined;
}

function newestSession(
  first: SessionState | undefined,
  second: SessionState | undefined,
): SessionState | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first.lastActivityAt >= second.lastActivityAt ? first : second;
}

function isActiveSession(
  state: SessionState | undefined,
  now: number,
): state is SessionState {
  if (state === undefined || !Number.isFinite(now)) return false;
  const inactivity = now - state.lastActivityAt;
  return inactivity >= 0 && inactivity < SESSION_INACTIVITY_TIMEOUT_MS;
}

function createRandomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  throw new Error("Web Crypto is required to create App Analytics IDs");
}

function keepWithinByteLimit(value: string, byteLimit: number): string {
  try {
    if (typeof globalThis.TextEncoder === "function") {
      return new TextEncoder().encode(value).byteLength <= byteLimit
        ? value
        : "";
    }
  } catch {
    // Fall through to a conservative bound for older browser runtimes.
  }

  return value.length * 3 <= byteLimit ? value : "";
}

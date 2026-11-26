import { SDK_NAME, SDK_VERSION, type EventContext } from "./event";
import { readGlobal, writeGlobal } from "./global-registry";

export const MAX_PAGE_PATH_BYTES = 2 * 1_024;
export const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
/**
 * Activity marks closer together than this are not written again. It bounds
 * storage writes during bursts of events; a session can end up to this much
 * earlier than the inactivity timeout implies.
 */
const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 1_000;
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

/** Returns the tab's active session, starting a new one after inactivity. */
export function getOrCreateSessionId(now = Date.now()): string {
  const { storage, memory, stored } = readSessionStates();
  const previous = newestSession(memory, stored);
  const state = isActiveSession(previous, now)
    ? previous
    : { id: createRandomId(), lastActivityAt: now };

  persistSessionState(state, { storage, memory, stored });
  return state.id;
}

/** Extends the session named by `sessionId` if it is still the tab's session. */
export function markSessionActivity(sessionId: string, now: number): void {
  if (!Number.isFinite(now)) return;

  const states = readSessionStates();
  const current = newestSession(states.memory, states.stored);
  if (current?.id !== sessionId) return;
  if (now - current.lastActivityAt < SESSION_ACTIVITY_WRITE_INTERVAL_MS) return;

  persistSessionState({ id: sessionId, lastActivityAt: now }, states);
}

export function createEventContext(
  sessionId: string,
  path: string = readPageLocation().path,
): EventContext {
  return {
    sessionId,
    path,
    sdkName: SDK_NAME,
    sdkVersion: SDK_VERSION,
  };
}

/** Whether `path` fits the page-path byte limit. */
export function isValidPagePath(path: unknown): path is string {
  return typeof path === "string" && fitsWithinBytes(path, MAX_PAGE_PATH_BYTES);
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
    return { path: withinPathLimit(url.pathname) };
  } catch {
    return { path: withinPathLimit(location.pathname) };
  }
}

function withinPathLimit(path: string): string {
  return fitsWithinBytes(path, MAX_PAGE_PATH_BYTES) ? path : "";
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

interface SessionStates {
  storage: Storage | undefined;
  memory: SessionState | undefined;
  stored: SessionState | undefined;
}

function readSessionStates(): SessionStates {
  const storage = readSessionStorage();
  return {
    storage,
    memory: readInMemorySession(),
    stored: storage === undefined ? undefined : readStoredSession(storage),
  };
}

/** Writes `state` only to the copies that do not already hold it. */
function persistSessionState(
  state: SessionState,
  { storage, memory, stored }: SessionStates,
): void {
  if (!isSameSession(memory, state)) writeInMemorySession(state);
  if (storage !== undefined && !isSameSession(stored, state)) {
    writeStoredSession(storage, state);
  }
}

function isSameSession(
  left: SessionState | undefined,
  right: SessionState,
): boolean {
  return left?.id === right.id && left.lastActivityAt === right.lastActivityAt;
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
  return parseSessionState(readGlobal(IN_MEMORY_SESSION_KEY));
}

function writeInMemorySession(state: SessionState): void {
  writeGlobal(IN_MEMORY_SESSION_KEY, state);
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

function fitsWithinBytes(value: string, byteLimit: number): boolean {
  try {
    if (typeof globalThis.TextEncoder === "function") {
      return new TextEncoder().encode(value).byteLength <= byteLimit;
    }
  } catch {
    // Fall through to a conservative bound for older browser runtimes.
  }

  return value.length * 3 <= byteLimit;
}

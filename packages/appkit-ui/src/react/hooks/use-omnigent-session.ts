import { useCallback, useEffect, useRef, useState } from "react";

import { connectSSE } from "@/js";

/** Session mode: `ask` pauses writes for approval, `read` denies them. */
export type OmnigentMode = "auto" | "ask" | "read";

/** One item of a session transcript (Omnigent's item shape, passed through). */
export interface OmnigentItem {
  id?: string;
  /** `message`, `function_call`, `function_call_output`, `error`, ... */
  type: string;
  created_at?: number;
  data?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    name?: string;
    arguments?: string;
    output?: string;
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A tool call waiting for the user's approval (`ask` mode). */
export interface OmnigentApproval {
  elicitation_id: string;
  params?: {
    message?: string;
    policy_name?: string;
    content_preview?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A session snapshot as the omnigent plugin returns it. */
export interface OmnigentSessionSnapshot {
  id: string;
  title?: string;
  /** `idle`, `running`, `failed`, ... */
  status?: string;
  mode?: OmnigentMode;
  harness?: string;
  llm_model?: string;
  items?: OmnigentItem[];
  pending_elicitations?: OmnigentApproval[];
  last_task_error?: { code?: string; message?: string } | null;
  [key: string]: unknown;
}

/** One parsed event from the session stream (Omnigent's event shape, passed through). */
export interface OmnigentStreamEvent {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

export interface OmnigentHarness {
  id: string;
  label: string;
  /** Has its own shell (runs sandboxed). */
  shell: boolean;
  models: string[];
  defaultModel?: string;
}

export interface StartOmnigentSession {
  harness?: string;
  model?: string;
  mode?: OmnigentMode;
  message?: string;
  title?: string;
}

const DEFAULT_BASE = "/api/omnigent";
/** Events that never change the snapshot. */
const QUIET_EVENTS = new Set([
  "session.heartbeat",
  "session.presence",
  "response.output_text.delta",
]);
/** Events after which the in-flight text is part of the transcript. */
const TURN_ENDS = new Set([
  "response.output_item.done",
  "response.completed",
  "response.failed",
]);

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body
        ? typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : JSON.stringify((body as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export interface UseOmnigentSessionOptions {
  /** Session to open. Omit (or `null`) to start one later with `start()`. */
  sessionId?: string | null;
  /** Where the omnigent plugin is mounted. Default `/api/omnigent`. */
  basePath?: string;
  /**
   * Called for every stream event before any state update: tool calls,
   * status changes, resource events. Errors thrown here are swallowed.
   */
  onEvent?: (event: OmnigentStreamEvent) => void;
}

export interface UseOmnigentSessionResult {
  sessionId: string | null;
  /** Latest snapshot, refreshed after every meaningful stream event. */
  session: OmnigentSessionSnapshot | null;
  items: OmnigentItem[];
  /** `idle`, `running`, `failed`, ... */
  status: string | null;
  isRunning: boolean;
  /** Assistant text of the turn in progress (not yet in `items`). */
  draft: string;
  /** Tool calls waiting for approval. */
  approvals: OmnigentApproval[];
  /** True while the session stream is connected. */
  isConnected: boolean;
  error: string | null;
  /** Create a session (and send its first message), then open it. Returns its id. */
  start: (opts?: StartOmnigentSession) => Promise<string>;
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  approve: (elicitationId: string) => Promise<void>;
  decline: (elicitationId: string) => Promise<void>;
  setMode: (mode: OmnigentMode) => Promise<void>;
  refresh: () => Promise<void>;
  /** Close the stream and forget the session (e.g. for "New thread"). */
  reset: () => void;
}

/**
 * React hook for one session of the `omnigent()` plugin.
 *
 * Loads the session's snapshot and keeps a live stream open: assistant text
 * accumulates in `draft` while a turn runs, and every other meaningful event
 * refreshes the snapshot, so `items`, `status`, `mode` and `approvals` stay
 * current. Actions call the plugin's routes and let the stream bring the
 * results in.
 *
 * @example
 * ```tsx
 * function Thread() {
 *   const s = useOmnigentSession();
 *   return (
 *     <>
 *       {s.items.map((it, i) => <Item key={it.id ?? i} item={it} />)}
 *       {s.draft && <p>{s.draft}</p>}
 *       {s.approvals.map((a) => (
 *         <button key={a.elicitation_id} onClick={() => s.approve(a.elicitation_id)}>
 *           Allow: {a.params?.message}
 *         </button>
 *       ))}
 *       <Composer onSend={(text) => (s.sessionId ? s.send(text) : s.start({ message: text }))} />
 *     </>
 *   );
 * }
 * ```
 */
export function useOmnigentSession({
  sessionId: initialId = null,
  basePath = DEFAULT_BASE,
  onEvent,
}: UseOmnigentSessionOptions = {}): UseOmnigentSessionResult {
  const [sessionId, setSessionId] = useState<string | null>(initialId);
  const [session, setSession] = useState<OmnigentSessionSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const idRef = useRef(sessionId);
  idRef.current = sessionId;
  const draftRef = useRef("");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow a controlled `sessionId` prop.
  useEffect(() => {
    setSessionId(initialId);
  }, [initialId]);

  const url = useCallback((p: string) => `${basePath}${p}`, [basePath]);

  const refresh = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    try {
      const snap = await requestJson<OmnigentSessionSnapshot>(
        url(`/sessions/${encodeURIComponent(id)}`),
      );
      if (idRef.current !== id) return;
      setSession(snap);
      if (snap.status !== "running" && draftRef.current) {
        draftRef.current = "";
        setDraft("");
      }
      setError(null);
    } catch (err) {
      if (idRef.current === id)
        setError(err instanceof Error ? err.message : String(err));
    }
  }, [url]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 150);
  }, [refresh]);

  // Snapshot + live stream for the open session.
  useEffect(() => {
    setSession(null);
    draftRef.current = "";
    setDraft("");
    if (!sessionId) return;
    const controller = new AbortController();
    void refresh();
    setIsConnected(true);
    connectSSE({
      url: url(`/sessions/${encodeURIComponent(sessionId)}/stream`),
      signal: controller.signal,
      // A GET of the session's live events is safe to reconnect.
      maxRetries: 5,
      onMessage: async ({ data }) => {
        if (controller.signal.aborted || !data) return;
        let event: OmnigentStreamEvent;
        try {
          event = JSON.parse(data) as OmnigentStreamEvent;
        } catch {
          return;
        }
        if (!event?.type) return;
        try {
          onEventRef.current?.(event);
        } catch {
          // a handler must not break the stream
        }
        if (
          event.type === "response.output_text.delta" &&
          typeof event.delta === "string"
        ) {
          draftRef.current += event.delta;
          setDraft(draftRef.current);
        }
        if (TURN_ENDS.has(event.type)) {
          draftRef.current = "";
          setDraft("");
        }
        if (!QUIET_EVENTS.has(event.type)) scheduleRefresh();
      },
      onError: (err) => {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Session stream failed",
          );
        }
      },
    })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Session stream failed",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsConnected(false);
      });
    return () => {
      controller.abort();
      setIsConnected(false);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [sessionId, url, refresh, scheduleRefresh]);

  const act = useCallback(
    async (fn: (id: string) => Promise<unknown>) => {
      const id = idRef.current;
      if (!id) throw new Error("No session: call start() first");
      try {
        await fn(id);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        scheduleRefresh();
      }
    },
    [scheduleRefresh],
  );

  const start = useCallback(
    async (opts: StartOmnigentSession = {}) => {
      try {
        const created = await requestJson<{ session_id: string }>(
          url("/sessions"),
          {
            method: "POST",
            body: JSON.stringify(opts),
          },
        );
        setError(null);
        idRef.current = created.session_id;
        setSessionId(created.session_id);
        return created.session_id;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [url],
  );

  const send = useCallback(
    (text: string) =>
      act((id) =>
        requestJson(url(`/sessions/${encodeURIComponent(id)}/messages`), {
          method: "POST",
          body: JSON.stringify({ text }),
        }),
      ),
    [act, url],
  );

  const interrupt = useCallback(
    () =>
      act((id) =>
        requestJson(url(`/sessions/${encodeURIComponent(id)}/interrupt`), {
          method: "POST",
        }),
      ),
    [act, url],
  );

  const resolve = useCallback(
    (eid: string, action: "accept" | "decline") =>
      act((id) =>
        requestJson(
          url(
            `/sessions/${encodeURIComponent(id)}/elicitations/${encodeURIComponent(eid)}`,
          ),
          { method: "POST", body: JSON.stringify({ action }) },
        ),
      ),
    [act, url],
  );
  const approve = useCallback(
    (eid: string) => resolve(eid, "accept"),
    [resolve],
  );
  const decline = useCallback(
    (eid: string) => resolve(eid, "decline"),
    [resolve],
  );

  const setMode = useCallback(
    (mode: OmnigentMode) =>
      act((id) =>
        requestJson(url(`/sessions/${encodeURIComponent(id)}/mode`), {
          method: "PUT",
          body: JSON.stringify({ mode }),
        }),
      ),
    [act, url],
  );

  const reset = useCallback(() => {
    idRef.current = null;
    setSessionId(null);
    setSession(null);
    draftRef.current = "";
    setDraft("");
    setError(null);
  }, []);

  const status = session?.status ?? null;
  return {
    sessionId,
    session,
    items: session?.items ?? [],
    status,
    isRunning: status === "running",
    draft,
    approvals: session?.pending_elicitations ?? [],
    isConnected,
    error,
    start,
    send,
    interrupt,
    approve,
    decline,
    setMode,
    refresh,
    reset,
  };
}

export interface UseOmnigentHarnessesResult {
  harnesses: OmnigentHarness[];
  modes: OmnigentMode[];
  defaultMode: OmnigentMode;
  defaultHarness: string | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** The harnesses (and gateway models) the signed-in user can pick. */
export function useOmnigentHarnesses(
  basePath = DEFAULT_BASE,
): UseOmnigentHarnessesResult {
  const [state, setState] = useState<
    Omit<UseOmnigentHarnessesResult, "reload">
  >({
    harnesses: [],
    modes: ["auto", "ask", "read"],
    defaultMode: "ask",
    defaultHarness: null,
    loading: true,
    error: null,
  });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const d = await requestJson<{
        harnesses: OmnigentHarness[];
        modes: OmnigentMode[];
        defaultMode: OmnigentMode;
        defaultHarness?: string;
      }>(`${basePath}/harnesses`);
      setState({
        harnesses: d.harnesses ?? [],
        modes: d.modes ?? ["auto", "ask", "read"],
        defaultMode: d.defaultMode ?? "ask",
        defaultHarness: d.defaultHarness ?? d.harnesses?.[0]?.id ?? null,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [basePath]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

export interface OmnigentSessionSummary {
  id: string;
  title?: string;
  status?: string;
  harness?: string;
  llm_model?: string;
  created_at?: number;
  updated_at?: number;
  [key: string]: unknown;
}

export interface UseOmnigentSessionsResult {
  sessions: OmnigentSessionSummary[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
}

/** The signed-in user's sessions, newest first. */
export function useOmnigentSessions(
  basePath = DEFAULT_BASE,
): UseOmnigentSessionsResult {
  const [sessions, setSessions] = useState<OmnigentSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await requestJson<{ data?: OmnigentSessionSummary[] }>(
        `${basePath}/sessions`,
      );
      setSessions(d.data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [basePath]);
  const remove = useCallback(
    async (sessionId: string) => {
      await requestJson(
        `${basePath}/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
      setSessions((s) => s.filter((x) => x.id !== sessionId));
    },
    [basePath],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { sessions, loading, error, reload, remove };
}

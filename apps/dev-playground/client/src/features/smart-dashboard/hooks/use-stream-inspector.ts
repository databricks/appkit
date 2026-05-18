import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SSEEvent } from "./use-agent-stream";

/**
 * Observability store for the agent SSE stream. Every chat message the
 * dashboard sends gets a `StreamRecord`; each event the adapter yields is
 * appended to that record with a relative timestamp. The Stream Inspector
 * drawer reads from here to render a human-legible timeline.
 *
 * State is module-level on purpose — multiple components (the chat section,
 * the agent sidebar, the inspector drawer itself) feed and read from the
 * same store without wiring props or context. React only re-renders when
 * `version` changes.
 */

export interface StreamEventRecord {
  event: SSEEvent;
  receivedAt: number;
}

export interface StreamRecord {
  id: string;
  label: string;
  startedAt: number;
  events: StreamEventRecord[];
}

const MAX_RECORDS = 5;

const state = {
  isOpen: false,
  records: [] as StreamRecord[],
};
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getVersion(): number {
  return version;
}

export function useStreamInspector(): {
  isOpen: boolean;
  records: StreamRecord[];
} {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return { isOpen: state.isOpen, records: state.records };
}

export function beginStreamRun(label: string): string {
  const id =
    (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: StreamRecord = {
    id,
    label,
    startedAt: performance.now(),
    events: [],
  };
  state.records = [record, ...state.records].slice(0, MAX_RECORDS);
  notify();
  return id;
}

export function recordStreamEvent(runId: string, event: SSEEvent): void {
  const record = state.records.find((r) => r.id === runId);
  if (!record) return;
  record.events.push({ event, receivedAt: performance.now() });
  notify();
}

export function openInspector(): void {
  state.isOpen = true;
  notify();
}

export function closeInspector(): void {
  state.isOpen = false;
  notify();
}

export function toggleInspector(): void {
  state.isOpen = !state.isOpen;
  notify();
}

export function clearInspectorHistory(): void {
  state.records = [];
  notify();
}

/**
 * Binds ⌘K / Ctrl+K to open-toggle and `Esc` to close. Mount once inside
 * the route.
 */
export function useInspectorShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        e.key === "k" &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        toggleInspector();
      } else if (e.key === "Escape" && state.isOpen) {
        closeInspector();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

/**
 * Convenience hook for the currently-open run's events. Used by the agent
 * sidebar's tiny "pulse" indicator next to each agent.
 */
export function useCurrentRun(): StreamRecord | null {
  const { records } = useStreamInspector();
  return records[0] ?? null;
}

// Dummy export to keep the "callback" shape callers can use if they want
// to opt out of the module-level store (none do today).
export const useStreamInspectorToggle: () => () => void = () =>
  useCallback(() => toggleInspector(), []);

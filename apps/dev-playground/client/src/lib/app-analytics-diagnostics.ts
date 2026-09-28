import type { AppAnalyticsDiagnostic } from "@databricks/appkit-ui/js/beta";
import { useSyncExternalStore } from "react";

/**
 * Tiny module store for App Analytics diagnostics.
 *
 * `<AppAnalytics />` is mounted once in `__root.tsx` and reports delivery
 * problems through `onDiagnostic`; the App Analytics page reads them back with
 * `useDiagnostics()`. `pushDiagnostic` is a module-level function, so passing
 * it as a prop keeps a stable identity and never re-initializes the client.
 */
export interface RecordedDiagnostic extends AppAnalyticsDiagnostic {
  receivedAt: number;
}

const MAX_DIAGNOSTICS = 50;

let diagnostics: ReadonlyArray<RecordedDiagnostic> = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function pushDiagnostic(diagnostic: AppAnalyticsDiagnostic): void {
  diagnostics = [
    { ...diagnostic, receivedAt: Date.now() },
    ...diagnostics,
  ].slice(0, MAX_DIAGNOSTICS);
  emit();
}

export function clearDiagnostics(): void {
  diagnostics = [];
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlyArray<RecordedDiagnostic> {
  return diagnostics;
}

export function useDiagnostics(): ReadonlyArray<RecordedDiagnostic> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

import type { StreamEntry } from "./types";

// clear a pending disconnect-grace timer so a removed/reconnected stream
// isn't pinned until it fires
export function clearGraceTimer(entry: StreamEntry): void {
  if (entry.disconnectGraceTimer) {
    clearTimeout(entry.disconnectGraceTimer);
    entry.disconnectGraceTimer = undefined;
  }
}

// clear a pending registry-removal timer so a reconnected/evicted stream
// isn't pulled out from under a client
export function clearRemovalTimer(entry: StreamEntry): void {
  if (entry.removalTimer) {
    clearTimeout(entry.removalTimer);
    entry.removalTimer = undefined;
  }
}

import type { Dirent } from "node:fs";

/**
 * Agent-folder names from a directory listing, sorted. An agent lives in a
 * subfolder, so directories count — and symlinks-to-directories too (a shared
 * agent folder linked into the agents dir). Single-sourced so the markdown and
 * code loaders keep the same folder-selection policy.
 */
export function agentDirNames(entries: Dirent[]): string[] {
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .sort();
}

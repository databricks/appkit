import type { Dirent } from "node:fs";

/**
 * Agent-folder names from a directory listing, sorted. An agent lives in a
 * subfolder, so only real directories count — symlinks are not followed, so a
 * link planted in the agents dir can't pull code from outside it. Single-sourced
 * so the markdown and code loaders keep the same folder-selection policy.
 */
export function agentDirNames(entries: Dirent[]): string[] {
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

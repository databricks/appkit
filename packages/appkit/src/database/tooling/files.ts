import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The destination of a write is a symbolic link, which a plain write would follow. */
export class SymlinkRefusedError extends Error {
  constructor(readonly file: string) {
    super(`${file} is a symbolic link`);
    this.name = "SymlinkRefusedError";
  }
}

/** Throw when `file` is a symbolic link, dangling or not. A missing or regular file passes. */
export function refuseSymlink(file: string): void {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new SymlinkRefusedError(file);
  }
}

/**
 * Replace `file` with `content` through a sibling temporary file and a rename,
 * so a crash leaves the old file or the new one, never half of either. The
 * rename would swap a link at `file` for a plain file; the refusal says so instead.
 */
export function writeFileAtomic(
  file: string,
  content: string,
  options: { readonly mode?: number } = {},
): void {
  refuseSymlink(file);
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { ...options, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

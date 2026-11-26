import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SymlinkRefusedError extends Error {
  constructor(readonly file: string) {
    super(`${file} is a symbolic link`);
    this.name = "SymlinkRefusedError";
  }
}

export function refuseSymlink(file: string): void {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new SymlinkRefusedError(file);
  }
}

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

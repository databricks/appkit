import { EXTENSION_CONTENT_TYPES } from "./defaults";

export function contentTypeFromPath(
  filePath: string,
  reported?: string,
): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const fromExt = EXTENSION_CONTENT_TYPES[ext];

  if (fromExt) {
    return fromExt;
  }

  return reported ?? "application/octet-stream";
}

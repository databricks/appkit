import { EXTENSION_CONTENT_TYPES } from "./defaults";

export function contentTypeFromPath(
  filePath: string,
  reported?: string,
): string {
  if (reported && reported !== "application/octet-stream") {
    return reported;
  }
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? reported ?? "application/octet-stream";
}

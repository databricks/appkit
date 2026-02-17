import type { PluginExecuteConfig } from "shared";

// // TODO: Tune defaults based on actual file operation characteristics
// export const filesDefaults: PluginExecuteConfig = {
//   cache: {
//     enabled: false,
//     ttl: 0,
//   },
//   retry: {
//     enabled: true,
//     initialDelay: 1000,
//     attempts: 3,
//   },
//   timeout: 30000,
// };

export const EXTENSION_CONTENT_TYPES: Record<string, string> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
});

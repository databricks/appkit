/**
 * Client-side parsing for POST /api/files/:volumeKey/bulk-download
 * (multipart/mixed with attachment parts + trailing JSON summary).
 */

export interface BulkDownloadSummaryEntry {
  path: string;
  success: boolean;
  error?: string;
  bytesWritten?: number;
}

function parseBoundary(contentType: string): string {
  const m = /boundary=([^;\s]+)/i.exec(contentType);
  if (!m) {
    throw new Error("Missing multipart boundary in Content-Type");
  }
  return m[1].replace(/^"|"$/g, "");
}

function startsWith(
  haystack: Uint8Array,
  needle: Uint8Array,
  offset: number,
): boolean {
  if (offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

function indexOfSequence(
  haystack: Uint8Array,
  needle: Uint8Array,
  start: number,
): number {
  for (let i = start; i <= haystack.length - needle.length; i++) {
    if (startsWith(haystack, needle, i)) return i;
  }
  return -1;
}

function findDoubleCrlf(haystack: Uint8Array, start: number): number {
  const crlf = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
  return indexOfSequence(haystack, crlf, start);
}

function parseFilename(headersBlock: string): string {
  const m =
    /filename="([^"]+)"/i.exec(headersBlock) ??
    /filename\*=UTF-8''([^;\s]+)/i.exec(headersBlock);
  return m?.[1] ? decodeURIComponent(m[1]) : "download";
}

function parseParts(
  buffer: ArrayBuffer,
  boundary: string,
): {
  attachments: { filename: string; body: Uint8Array }[];
  summary: BulkDownloadSummaryEntry[] | null;
} {
  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: false });
  const u8 = new Uint8Array(buffer);
  const open = enc.encode(`--${boundary}\r\n`);
  const next = enc.encode(`\r\n--${boundary}\r\n`);
  const close = enc.encode(`\r\n--${boundary}--`);

  const attachments: { filename: string; body: Uint8Array }[] = [];
  let summary: BulkDownloadSummaryEntry[] | null = null;

  let pos = 0;
  if (!startsWith(u8, open, pos)) {
    throw new Error("Invalid multipart body: missing initial boundary");
  }
  pos += open.length;

  while (pos < u8.length) {
    const headerEnd = findDoubleCrlf(u8, pos);
    if (headerEnd === -1) break;

    const headersText = dec.decode(u8.subarray(pos, headerEnd));
    const bodyStart = headerEnd + 4;

    const disposition = /Content-Disposition:\s*([^\r\n]+)/i.exec(headersText);
    const disp = disposition?.[1] ?? "";
    const isSummary =
      disp.includes("inline") && disp.includes('name="summary"');
    const isAttachment = disp.includes("attachment");

    const clMatch = /Content-Length:\s*(\d+)/i.exec(headersText);
    const contentLength = clMatch ? Number.parseInt(clMatch[1], 10) : null;

    if (isAttachment && contentLength !== null) {
      attachments.push({
        filename: parseFilename(headersText),
        body: u8.subarray(bodyStart, bodyStart + contentLength),
      });
      pos = bodyStart + contentLength;
    } else if (isSummary) {
      const endClose = indexOfSequence(u8, close, bodyStart);
      if (endClose === -1) {
        throw new Error("Invalid multipart body: missing closing boundary");
      }
      let jsonBytes = u8.subarray(bodyStart, endClose);
      while (
        jsonBytes.length > 0 &&
        (jsonBytes[jsonBytes.length - 1] === 0x0a ||
          jsonBytes[jsonBytes.length - 1] === 0x0d)
      ) {
        jsonBytes = jsonBytes.subarray(0, jsonBytes.length - 1);
      }
      const jsonText = dec.decode(jsonBytes).trim();
      summary = JSON.parse(jsonText) as BulkDownloadSummaryEntry[];
      break;
    } else {
      const nextPart = indexOfSequence(u8, next, bodyStart);
      const endAlt = indexOfSequence(u8, close, bodyStart);
      if (nextPart !== -1 && (endAlt === -1 || nextPart < endAlt)) {
        pos = nextPart + next.length;
      } else if (endAlt !== -1) {
        break;
      } else {
        break;
      }
    }

    if (startsWith(u8, next, pos)) {
      pos += next.length;
      continue;
    }
    if (startsWith(u8, close, pos)) {
      break;
    }
    if (pos >= u8.length) break;
  }

  return { attachments, summary };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Parses the bulk-download response, saves each attachment via object URL download,
 * and returns the summary part (or an empty array if missing).
 *
 * NOTE: This loads the entire response into an ArrayBuffer before parsing.
 * For very large bulk downloads, consider a streaming approach using
 * `response.body.getReader()` to parse parts incrementally.
 */
export async function saveBulkDownloadResponse(
  response: Response,
): Promise<BulkDownloadSummaryEntry[]> {
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(err.error ?? `HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/mixed")) {
    throw new Error("Expected multipart/mixed response from bulk-download");
  }

  const boundary = parseBoundary(contentType);
  const buffer = await response.arrayBuffer();
  const { attachments, summary } = parseParts(buffer, boundary);

  for (const { filename, body } of attachments) {
    const blob = new Blob([body], { type: "application/octet-stream" });
    triggerDownload(blob, filename);
  }

  return summary ?? [];
}

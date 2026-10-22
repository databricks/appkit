export function streamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// Creates a ReadableStream that yields multiple chunks
export function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// Builds the HEAD response the connector's metadata() reads headers from.
export function headResponse(
  headers: Record<string, string | number | undefined>,
): Response {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) h.set(key, String(value));
  }
  return new Response(null, { headers: h });
}

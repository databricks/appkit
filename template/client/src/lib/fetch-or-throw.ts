import { z } from 'zod';

// AppKit plugins and the template's routes send `{ error }` in their JSON error responses.
const ServerErrorSchema = z.object({ error: z.string() });

/** Fetches `url` and throws on an error status, with the server's message or `fallback`. */
export async function fetchOrThrow(
  url: string,
  init: RequestInit | undefined,
  fallback: (response: Response) => string,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = ServerErrorSchema.safeParse(
      await response.json().catch(() => null),
    );
    throw new Error(body.success ? body.data.error : fallback(response));
  }
  return response;
}

/** Like `fetchOrThrow`, then parses the JSON body with `schema`. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit | undefined,
  schema: z.ZodType<T>,
  fallback: (response: Response) => string,
): Promise<T> {
  const response = await fetchOrThrow(url, init, fallback);
  const body = schema.safeParse(await response.json());
  if (!body.success) {
    throw new Error(
      `Unexpected response from ${url}: ${z.prettifyError(body.error)}`,
    );
  }
  return body.data;
}

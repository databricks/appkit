export async function fetchOrThrow(
  url: string,
  init: RequestInit | undefined,
  errorMessage: (response: Response) => string | Promise<string>,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response;
}

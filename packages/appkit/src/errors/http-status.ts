/**
 * The HTTP status carried by a thrown Error: `statusCode` (the workspace-client
 * and legacy SDK `ApiError`) or `httpStatusCode` (the modular SDK's sdk-core
 * `ApiError`, which reports -1 when there was no HTTP response).
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const { statusCode, httpStatusCode } = error as {
    statusCode?: unknown;
    httpStatusCode?: unknown;
  };
  const status = typeof statusCode === "number" ? statusCode : httpStatusCode;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

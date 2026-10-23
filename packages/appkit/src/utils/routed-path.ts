/**
 * The path Express routes a request target by: without its query, and without
 * the scheme and authority of an absolute-form target, which a server must
 * accept (RFC 9112, section 3.2.2).
 */
export function routedPath(target: string): string {
  const path = target.split("?")[0];
  return path.startsWith("/")
    ? path
    : path.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, "");
}

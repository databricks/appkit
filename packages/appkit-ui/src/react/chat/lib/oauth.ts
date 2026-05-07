/**
 * Detection and parsing helpers for OAuth credential errors thrown when a
 * tool call requires user authentication that hasn't been completed yet.
 *
 * Expected error format:
 * "Failed request to https://... Error: Credential for user identity('___') is not found
 * for the connection 'CONNECTION_NAME'. Please login first to the connection by visiting https://LOGIN_URL"
 */

const CREDENTIAL_ERROR_PATTERN =
  /Credential for user identity\([^)]*\) is not found for the connection/i;

const LOGIN_URL_PATTERN =
  /please login first to the connection by visiting\s+(https?:\/\/[^\s]+)/i;

const CONNECTION_NAME_PATTERN = /for the connection\s+'([^']+)'/i;

export function isCredentialErrorMessage(errorMessage: string): boolean {
  return CREDENTIAL_ERROR_PATTERN.test(errorMessage);
}

export function findLoginURLFromCredentialErrorMessage(
  errorMessage: string,
): string | undefined {
  return errorMessage.match(LOGIN_URL_PATTERN)?.[1];
}

export function findConnectionNameFromCredentialErrorMessage(
  errorMessage: string,
): string | undefined {
  return errorMessage.match(CONNECTION_NAME_PATTERN)?.[1];
}

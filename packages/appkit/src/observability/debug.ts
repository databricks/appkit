import { createDebug as createObug, type Debugger } from "obug";

/**
 * Create a debug logger using obug
 * RESPECTS DEBUG=appkit:* environment variable
 * @param scope - Debug scope name (will be prefixed with "appkit:")
 * @returns - Debugger instance
 */
export function createDebug(scope: string): Debugger {
  return createObug(`appkit:${scope}`, { useColors: true });
}

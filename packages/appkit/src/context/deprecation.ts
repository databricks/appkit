import { createLogger } from "../logging/logger";

const logger = createLogger("execution-context");
const warned = new Set<string>();

export function warnContextDeprecation(
  name: string,
  replacement: string,
): void {
  if (warned.has(name)) return;
  warned.add(name);
  logger.warn(`${name} is deprecated. Use ${replacement} instead.`);
}

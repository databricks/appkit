import { AppKitError } from "./base";

/**
 * Thrown when an agent with an `output` schema could not produce a
 * schema-valid value within the structuring retry budget — the caller gets a
 * valid object or this error, never partial data. Carries the last raw model
 * output (`lastRaw`) for debugging, server-side only: it is never returned to
 * the client, which sees the generic {@link clientMessage}.
 *
 * @example
 * ```typescript
 * try {
 *   const { output } = await runAgent(classifier, { messages: "..." });
 * } catch (e) {
 *   if (e instanceof StructuredOutputError) {
 *     // model couldn't produce schema-valid JSON; e.lastRaw has the attempt
 *   }
 * }
 * ```
 */
export class StructuredOutputError extends AppKitError {
  readonly code = "STRUCTURED_OUTPUT_ERROR";
  readonly statusCode = 500;
  readonly isRetryable = false;

  /**
   * Last raw model output that failed to parse/validate. Server-side only —
   * kept off {@link clientMessage} since it can echo arbitrary model text.
   */
  readonly lastRaw?: string;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      lastRaw?: string;
    },
  ) {
    super(message, options);
    this.lastRaw = options?.lastRaw;
  }

  override get clientMessage(): string {
    return this._clientMessage ?? "The agent could not produce a valid result";
  }
}

import { AppKitError } from "./base";

/**
 * Thrown when an agent with an `output` schema could not produce a value that
 * validates against it, even after the structuring retries are exhausted.
 * Carries the last raw model output (server-side only) for debugging — it is
 * never returned to the client, which sees the generic {@link clientMessage}.
 *
 * The structured-output path throws this rather than returning partial or
 * unvalidated data: a caller that asked for a typed object gets either a valid
 * one or an error, never a half-parsed shape.
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

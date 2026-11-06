import { AppKitError } from "./base";

/** Cap how many issues one rejection can put on the wire. */
const MAX_ISSUES = 50;

/** One rejected field; `path` names public columns, never their values. */
export interface DatabaseValidationIssue {
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * Deliberate validation failure. An explicit transaction callback can throw it,
 * and the transaction rethrows that same error. Generated routes answer `422`
 * and echo only the issues naming a public column. Every other failure stays
 * an opaque server error.
 */
export class DatabaseValidationError extends AppKitError {
  readonly code = "DATABASE_VALIDATION_ERROR";
  readonly statusCode = 422;
  readonly isRetryable = false;
  readonly issues: readonly DatabaseValidationIssue[];

  constructor(
    message: string,
    issues: readonly DatabaseValidationIssue[] = [],
  ) {
    super(message, { clientMessage: "Database request failed validation" });
    this.issues = issues.slice(0, MAX_ISSUES);
  }
}

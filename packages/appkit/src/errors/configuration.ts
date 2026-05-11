import pc from "picocolors";
import { AppKitError } from "./base";

function authSetupVerbose(): boolean {
  return (
    process.env.APPKIT_VERBOSE_AUTH_ERRORS === "1" ||
    process.env.APPKIT_VERBOSE_AUTH_ERRORS === "true"
  );
}

/** Pulls ` $ databricks ...` from SDK text when present. */
function suggestedDatabricksCliCommand(detail: string): string | undefined {
  const m = detail.match(/\$\s*(databricks[^\n]+)/);
  return m?.[1]?.trim();
}

/** Makes `console.error` show only the message (no stack, no extra fields). */
function pinUserFacingAuthError(err: ConfigurationError): void {
  Object.defineProperty(err, "stack", {
    value: "",
    configurable: true,
    enumerable: false,
    writable: true,
  });
  Object.defineProperty(err, Symbol.for("nodejs.util.inspect.custom"), {
    value: function (this: ConfigurationError): string {
      return this.message;
    },
    enumerable: false,
    configurable: true,
  });
}

/**
 * Error thrown when configuration is missing or invalid.
 * Use for missing environment variables, invalid settings, or setup issues.
 *
 * @example
 * ```typescript
 * throw new ConfigurationError("DATABRICKS_HOST environment variable is required");
 * throw new ConfigurationError("Warehouse ID not found", { context: { env: "production" } });
 * ```
 */
export class ConfigurationError extends AppKitError {
  readonly code = "CONFIGURATION_ERROR";
  readonly statusCode = 500;
  readonly isRetryable = false;

  /**
   * Create a configuration error for missing environment variable
   */
  static missingEnvVar(varName: string): ConfigurationError {
    return new ConfigurationError(
      `${varName} environment variable is required`,
      { context: { envVar: varName } },
    );
  }

  /**
   * Create a configuration error for missing resource
   */
  static resourceNotFound(resource: string, hint?: string): ConfigurationError {
    const message = hint
      ? `${resource} not found. ${hint}`
      : `${resource} not found`;
    return new ConfigurationError(message, { context: { resource } });
  }

  /**
   * Create a configuration error for invalid connection config
   */
  static invalidConnection(
    service: string,
    details?: string,
  ): ConfigurationError {
    const message = details
      ? `${service} connection not configured. ${details}`
      : `${service} connection not configured`;
    return new ConfigurationError(message, { context: { service } });
  }

  /**
   * Create a configuration error for missing connection string parameter
   */
  static missingConnectionParam(param: string): ConfigurationError {
    return new ConfigurationError(
      `Connection string must include ${param} parameter`,
      { context: { parameter: param } },
    );
  }

  /**
   * Databricks CLI / token auth failed while creating the workspace client.
   *
   * By default the message is short; key lines use **picocolors** when the
   * terminal supports it (also respects `NO_COLOR`). `console.error` won’t show
   * stacks or `{ code, context, … }`. Set `APPKIT_VERBOSE_AUTH_ERRORS=1` for full
   * `cause`, stack, and the raw SDK message (verbose appendix is unstyled).
   */
  static databricksAuthenticationSetupFailed(
    detail: string,
    options?: { cause?: Error },
  ): ConfigurationError {
    const verbose = authSetupVerbose();
    const host = process.env.DATABRICKS_HOST ?? "(not set)";
    const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
    const d = detail.trim();
    const cli = suggestedDatabricksCliCommand(d);

    const title = pc.bold(pc.red("Databricks authentication failed."));
    const action = cli
      ? `${pc.bold("Run this, then try again:")}\n  ${pc.cyan(cli)}`
      : pc.yellow(
          "Log in with the Databricks CLI (for example, databricks auth login for this workspace), then try again.",
        );
    const tokenHint = pc.dim(
      "Or set DATABRICKS_TOKEN and DATABRICKS_HOST instead of CLI-based auth.",
    );

    const lines: string[] = [
      title,
      "",
      action,
      "",
      tokenHint,
      "",
      `${pc.green("DATABRICKS_HOST")}: ${host}`,
    ];
    if (warehouseId) {
      lines.push(`${pc.green("DATABRICKS_WAREHOUSE_ID")}: ${warehouseId}`);
    }
    if (verbose) {
      lines.push("", d);
    }

    const err = new ConfigurationError(lines.join("\n"), {
      cause: verbose ? options?.cause : undefined,
    });

    if (!verbose) {
      pinUserFacingAuthError(err);
    }
    return err;
  }
}

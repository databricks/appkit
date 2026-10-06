import { createContextKey, context as otelContext } from "@opentelemetry/api";
import type { Request } from "express";

import { AuthenticationError } from "../errors";
import { createLogger } from "../logging/logger";
import { runInCallerContext } from "./execution-context";
import { ServiceContext } from "./service-context";

const logger = createLogger("execution-context");
const DEV_OBO_FALLBACK_KEY = createContextKey("appkit.devOboFallback");

/** Internal scope shared by shorthand calls and the whole run block. */
export interface RequestScope {
  run<T>(fn: () => T): T;
}

export function isDevOboFallback(): boolean {
  return otelContext.active().getValue(DEV_OBO_FALLBACK_KEY) === true;
}

/** Build the caller once from the trusted Apps proxy headers. */
export function createRequestScope(
  req: Request,
  createCaller = ServiceContext.createCallerContext,
): RequestScope {
  const token = req.header("x-forwarded-access-token")?.trim();
  const userId = req.header("x-forwarded-user")?.trim();
  const userEmail = req.header("x-forwarded-email");
  const isDev = process.env.NODE_ENV === "development";

  if (!token && isDev) {
    logger.warn(
      "asUser() called without user token in development mode. Skipping user impersonation.",
    );
    return {
      run: (fn) =>
        otelContext.with(
          otelContext.active().setValue(DEV_OBO_FALLBACK_KEY, true),
          fn,
        ),
    };
  }
  if (!token) throw AuthenticationError.missingToken("user token");
  if (!userId && !isDev) throw AuthenticationError.missingUserId();

  const caller = createCaller(
    token,
    userId || "dev-user",
    undefined,
    userEmail,
  );
  return { run: (fn) => runInCallerContext(caller, fn) };
}

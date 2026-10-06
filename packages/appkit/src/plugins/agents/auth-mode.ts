import { AsyncLocalStorage } from "node:async_hooks";

import type express from "express";

import { getWorkspaceClient } from "../../context";
import { getClientOptions } from "../../context/client-options";
import type { AgentAuth } from "../../core/agent/types";
import { AuthenticationError } from "../../errors";
import { createWorkspaceClient } from "../../workspace-client";

/** Marks the part of a run that executes on behalf of the user. */
const oboRun = new AsyncLocalStorage<true>();

export function isOboAgentRun(): boolean {
  return oboRun.getStore() === true;
}

export function runInOboAgentRun<T>(fn: () => T): T {
  return oboRun.run(true, fn);
}

export function isOnBehalfOfUser(auth: AgentAuth | undefined): boolean {
  return auth === "on-behalf-of-user";
}

/**
 * Fail closed before an on-behalf-of-user run: a forwarded user token and user
 * id are required in production and in development alike. There is no
 * service-principal fallback.
 */
export function requireOboCaller(req: express.Request): void {
  const token = req.header("x-forwarded-access-token")?.trim();
  if (!token) throw AuthenticationError.missingToken("user token");
  if (!req.header("x-forwarded-user")?.trim()) {
    throw AuthenticationError.missingUserId();
  }
}

type ClientLike = {
  apiClient: { request(options: Record<string, unknown>): Promise<unknown> };
};

/**
 * Client for AppKit-built model adapters. Inside an on-behalf-of-user run it
 * is the caller's client; otherwise it is the app service principal client,
 * created once at build time exactly as before.
 */
export function modelClientProvider(): () => ClientLike {
  const servicePrincipal = createWorkspaceClient({
    clientOptions: getClientOptions(),
  }) as unknown as ClientLike;
  return () =>
    isOboAgentRun()
      ? (getWorkspaceClient() as unknown as ClientLike)
      : servicePrincipal;
}

import type { Request } from "express";

/**
 * Context passed through the interceptor chain.
 * Contains signal for cancellation, metadata, and user identification.
 */
export interface InterceptorContext {
  signal?: AbortSignal;
  metadata?: Map<string, any>;
  userKey: string;
  request?: Request;
}

export interface ExecutionInterceptor {
  intercept<T>(fn: () => Promise<T>, context: InterceptorContext): Promise<T>;
}

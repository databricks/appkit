export interface ExecutionContext {
  signal?: AbortSignal;
  metadata?: Map<string, any>;
  userKey: string;
  asUser?: boolean;
}

export interface ExecutionInterceptor {
  intercept<T>(fn: () => Promise<T>, context: ExecutionContext): Promise<T>;
}

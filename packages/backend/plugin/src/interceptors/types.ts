export interface ExecutionContext {
  signal?: AbortSignal;
  metadata?: Map<string, any>;
  userToken?: string;
}

export interface ExecutionInterceptor {
  intercept<T>(fn: () => Promise<T>, context: ExecutionContext): Promise<T>;
}

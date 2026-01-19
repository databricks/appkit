import type { LogLevel } from "./types";

export interface QueryData {
  key?: string;
  warehouse_id?: string;
  rows_returned?: number;
  query_duration_ms?: number;
  bytes_scanned?: number;
  [key: string]: unknown;
}

/**
 * WideEvent data interface
 * - Represents a single event for a request
 * - Fields are camelCase to match OpenTelemetry
 */
export interface WideEventData {
  // request metadata
  timestamp: string;
  request_id: string;
  trace_id?: string;
  method?: string;
  path?: string;
  status_code?: number;
  duration_ms?: number;

  // service metadata
  service?: {
    name: string;
    version: string;
    region?: string;
    deployment_id?: string;
    node_env?: string;
  };

  // component metadata (plugin, connector, or service)
  component?: {
    name: string;
    operation?: string;
  };

  // user metadata
  user?: {
    id?: string;
    [key: string]: unknown;
  };

  // execution metadata
  execution?: {
    cache_hit?: boolean;
    cache_key?: string;
    cache_deduplication?: boolean;
    retry_attempts?: number;
    timeout_ms?: number;
    [key: string]: unknown;
  };

  // stream metadata
  stream?: {
    stream_id?: string;
    events_sent?: number;
    buffer_size?: number;
    reconnections?: number;
    [key: string]: unknown;
  };

  // error metadata
  error?: {
    type: string;
    code: string;
    message: string;
    retriable?: boolean;
    cause?: string;
  };

  // log metadata
  logs?: Array<{
    level: LogLevel;
    message: string;
    timestamp: string;
    context?: Record<string, unknown>;
  }>;

  /**
   * Scoped context data
   * Each scope (plugin, connector, service) can add its own namespaced data here.
   * Example: { analytics: { query_key: "..."}, "sql-warehouse": { warehouse_id: "..."} }
   */
  context?: Record<string, Record<string, unknown>>;

  [key: string]: unknown;
}

/**
 * WideEvent
 * - Represents a single event for a request
 * - Fields are camelCase to match OpenTelemetry
 */
export class WideEvent {
  public data: WideEventData;
  private startTime: number;

  constructor(requestId: string) {
    this.startTime = Date.now();
    this.data = {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      service: {
        name: "appkit",
        version: process.env.npm_package_version || "unknown",
        region: process.env.REGION,
        deployment_id: process.env.DEPLOYMENT_ID,
        node_env: process.env.NODE_ENV,
      },
      logs: [],
      context: {},
    };
  }

  /**
   * Set a value in the event
   * @param key - The key to set
   * @param value - The value to set
   * @returns The event
   */
  set<K extends keyof WideEventData>(key: K, value: WideEventData[K]): this {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // merge objects
      this.data[key] = {
        ...(this.data[key] as object),
        ...value,
      } as WideEventData[K];
    } else {
      this.data[key] = value;
    }
    return this;
  }

  /**
   * Set the component name and operation.
   * Component can be a plugin, connector, or service.
   * @param name - The name of the component (e.g., "analytics", "sql-warehouse", "cache-manager")
   * @param operation - The operation being performed (e.g., "query", "getOrExecute")
   * @returns The event
   */
  setComponent(name: string, operation?: string): this {
    this.data.component = { name, operation };
    return this;
  }

  /**
   * Set the user context
   * @param user - The user context
   * @returns The event
   */
  setUser(user: WideEventData["user"]): this {
    this.data.user = { ...this.data.user, ...user };
    return this;
  }

  /**
   * Set the execution context
   * @param execution - The execution context
   * @returns The event
   */
  setExecution(execution: WideEventData["execution"]): this {
    this.data.execution = { ...this.data.execution, ...execution };
    return this;
  }

  /**
   * Set the stream context
   * @param stream - The stream context
   * @returns The event
   */
  setStream(stream: WideEventData["stream"]): this {
    this.data.stream = { ...this.data.stream, ...stream };
    return this;
  }

  /**
   * Set the error context
   * @param error - The error context
   * @returns The event
   */
  setError(error: Error): this {
    const isAppKitError = "code" in error && "statusCode" in error;
    const errorCause = (error as any).cause;

    this.data.error = {
      type: error.name,
      code: isAppKitError ? (error as any).code : "UNKNOWN_ERROR",
      message: error.message,
      retriable: isAppKitError ? (error as any).isRetryable : false,
      cause: errorCause ? String(errorCause) : undefined,
    };

    return this;
  }

  /**
   * Add scoped context to the event
   * @param scope - The scope name (plugin, connector, or service name)
   * @param ctx - Context data to merge
   * @example
   * event.setContext("analytics", { query_key: "apps_list", rows_returned: 100 });
   * event.setContext("sql-warehouse", { warehouse_id: "1234567890" });
   */
  setContext(scope: string, ctx: Record<string, unknown>): this {
    if (!this.data.context) {
      this.data.context = {};
    }

    this.data.context[scope] = {
      ...this.data.context[scope],
      ...ctx,
    };

    return this;
  }

  /**
   * Add a log to the event
   * @param level - The level of the log
   * @param message - The message of the log
   * @param context - The context of the log
   * @returns The event
   */
  addLog(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): this {
    if (!this.data.logs) {
      this.data.logs = [];
    }

    this.data.logs.push({
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
    });

    // Keep only last 50 logs to prevent unbounded growth
    if (this.data.logs.length > 50) {
      this.data.logs = this.data.logs.slice(-50);
    }

    return this;
  }

  /**
   * Finalize the event
   * @param statusCode - The status code of the response
   * @returns The event data
   */
  finalize(statusCode: number): WideEventData {
    this.data.status_code = statusCode;
    this.data.duration_ms = this.getDurationMs();
    return this.data;
  }

  /**
   * Get the duration of the event in milliseconds
   * @returns The duration of the event in milliseconds
   */
  getDurationMs(): number {
    return this.data.duration_ms || Date.now() - this.startTime;
  }

  /**
   * Convert the event to a JSON object
   * @returns The event data as a JSON object
   */
  toJSON(): WideEventData {
    return this.data;
  }
}

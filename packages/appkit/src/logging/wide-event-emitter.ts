import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { WideEventData } from "./wide-event";

/**
 * Emits WideEvents to OpenTelemetry as structured logs
 */
export class WideEventEmitter {
  private logger = logs.getLogger("appkit", "1.0.0");

  /**
   * Emit a WideEvent to OpenTelemetry.
   * Fails silently to avoid crashing the application due to observability issues.
   */
  emit(event: WideEventData): void {
    try {
      const logRecord = {
        timestamp: Date.parse(event.timestamp),
        severityNumber: this.getSeverityNumber(event),
        severityText: this.getSeverityText(event),
        body: this.createLogBody(event),
        attributes: this.createAttributes(event),
      };

      this.logger.emit(logRecord);
    } catch {
      // Silent fail - observability should never crash the application
    }
  }

  /**
   * Get OpenTelemetry severity number based on event data
   */
  private getSeverityNumber(event: WideEventData): SeverityNumber {
    // Error level
    if (event.error) {
      return SeverityNumber.ERROR;
    }

    // Status code based
    if (event.status_code) {
      if (event.status_code >= 500) {
        return SeverityNumber.ERROR;
      }
      if (event.status_code >= 400) {
        return SeverityNumber.WARN;
      }
    }

    // Check logs for errors/warnings
    if (event.logs) {
      const hasError = event.logs.some((log) => log.level === "error");
      if (hasError) {
        return SeverityNumber.ERROR;
      }

      const hasWarn = event.logs.some((log) => log.level === "warn");
      if (hasWarn) {
        return SeverityNumber.WARN;
      }
    }

    return SeverityNumber.INFO;
  }

  /**
   * Get severity text based on severity number
   */
  private getSeverityText(event: WideEventData): string {
    const severityNumber = this.getSeverityNumber(event);

    if (severityNumber >= SeverityNumber.ERROR) {
      return "ERROR";
    }
    if (severityNumber >= SeverityNumber.WARN) {
      return "WARN";
    }
    if (severityNumber >= SeverityNumber.INFO) {
      return "INFO";
    }
    return "DEBUG";
  }

  /**
   * Create log body from event data
   */
  private createLogBody(event: WideEventData): string {
    const parts: string[] = [];

    // HTTP request info
    if (event.method && event.path) {
      parts.push(`${event.method} ${event.path}`);
    }

    // Status code
    if (event.status_code) {
      parts.push(`→ ${event.status_code}`);
    }

    // Duration
    if (event.duration_ms) {
      parts.push(`(${event.duration_ms}ms)`);
    }

    // Component info
    if (event.component) {
      const componentStr = event.component.operation
        ? `${event.component.name}.${event.component.operation}`
        : event.component.name;
      parts.push(`[${componentStr}]`);
    }

    // Error message
    if (event.error) {
      parts.push(`ERROR: ${event.error.message}`);
    }

    return parts.join(" ");
  }

  /**
   * Create OpenTelemetry attributes from event data
   */
  private createAttributes(
    event: WideEventData,
  ): Record<string, string | number | boolean | undefined> {
    const attributes: Record<string, string | number | boolean | undefined> = {
      // Request metadata
      request_id: event.request_id,
      trace_id: event.trace_id,

      // HTTP attributes (OpenTelemetry semantic conventions)
      "http.method": event.method,
      "http.route": event.path,
      "http.status_code": event.status_code,
      "http.request.duration_ms": event.duration_ms,

      // Service attributes
      "service.name": event.service?.name,
      "service.version": event.service?.version,
      "service.region": event.service?.region,
      "service.deployment_id": event.service?.deployment_id,
      "service.node_env": event.service?.node_env,

      // Component attributes
      "component.name": event.component?.name,
      "component.operation": event.component?.operation,

      // User attributes
      "user.id": event.user?.id,

      // Error attributes
      "error.type": event.error?.type,
      "error.code": event.error?.code,
      "error.message": event.error?.message,
      "error.retriable": event.error?.retriable,

      // Execution metadata
      "execution.timeout_ms": event.execution?.timeout_ms,
      "execution.retry_attempts": event.execution?.retry_attempts,
      "execution.cache_hit": event.execution?.cache_hit,
      "execution.cache_key": event.execution?.cache_key,
      "execution.cache_deduplication": event.execution?.cache_deduplication,

      // Stream metadata
      "stream.id": event.stream?.stream_id,
      "stream.events_sent": event.stream?.events_sent,

      // Log count
      log_count: event.logs?.length,
    };

    // Add custom context as attributes with scope prefix (no "appkit" prefix)
    if (event.context) {
      for (const [scope, scopeData] of Object.entries(event.context)) {
        for (const [key, value] of Object.entries(scopeData)) {
          // Only add primitive values
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            attributes[`${scope}.${key}`] = value;
          }
        }
      }
    }

    // Remove undefined values
    return Object.fromEntries(
      Object.entries(attributes).filter(([_, value]) => value !== undefined),
    );
  }
}

import type { WideEventData } from "./wide-event";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

// format JSON - production
export function formatJson(data: WideEventData): string {
  return JSON.stringify(data);
}

// format as human-readable - development
/**
 * Format WideEvent as human-readable colored output (for development).
 */
export function formatPretty(data: WideEventData): string {
  const { reset, dim, bold, green, yellow, red, cyan, magenta } = COLORS;

  // Status color
  const statusColor =
    data.status_code && data.status_code >= 500
      ? red
      : data.status_code && data.status_code >= 400
        ? yellow
        : green;

  // Header line
  let output = `${dim}${data.timestamp}${reset} `;
  output += `${statusColor}${data.status_code || "---"}${reset} `;
  output += `${bold}${data.method || "?"} ${data.path || "/"}${reset} `;
  output += `${dim}${data.duration_ms || 0}ms${reset}`;

  if (data.request_id) {
    output += ` ${dim}(${data.request_id.slice(0, 8)})${reset}`;
  }

  // Component info (plugin, connector, or service)
  if (data.component) {
    output += `\n  ${cyan}component:${reset} ${data.component.name}`;
    if (data.component.operation) output += `.${data.component.operation}`;
  }

  // User info
  if (data.user?.id) {
    output += `\n  ${cyan}user:${reset} ${data.user.id}`;
  }

  // Execution info
  if (data.execution) {
    const exec = data.execution;
    const parts: string[] = [];
    if (exec.cache_hit !== undefined) {
      parts.push(`cache:${exec.cache_hit ? "HIT" : "MISS"}`);
    }
    if (exec.cache_key) {
      parts.push(`key:${exec.cache_key.substring(0, 16)}...`);
    }
    if (exec.retry_attempts) parts.push(`retries:${exec.retry_attempts}`);
    if (exec.timeout_ms) parts.push(`timeout:${exec.timeout_ms}ms`);
    if (parts.length) {
      output += `\n  ${cyan}execution:${reset} ${parts.join(", ")}`;
    }
  }

  // Scoped context (plugin, connector, service specific data)
  if (data.context) {
    for (const [scopeName, context] of Object.entries(data.context)) {
      const contextStr = Object.entries(context)
        .map(([k, v]) => `${k}:${formatValue(v)}`)
        .join(", ");
      output += `\n  ${magenta}${scopeName}:${reset} ${contextStr}`;
    }
  }

  // Logs (if any)
  if (data.logs && data.logs.length > 0) {
    output += `\n  ${cyan}logs:${reset}`;
    for (const log of data.logs) {
      const levelColor =
        log.level === "error" ? red : log.level === "warn" ? yellow : dim;
      output += `\n    ${levelColor}[${log.level}]${reset} ${log.message}`;
      if (log.context) {
        output += ` ${dim}${JSON.stringify(log.context)}${reset}`;
      }
    }
  }

  // Error info
  if (data.error) {
    output += `\n  ${red}error:${reset} ${data.error.type}: ${data.error.message}`;
    if (data.error.code) output += ` [${data.error.code}]`;
    if (data.error.cause)
      output += `\n  ${magenta}cause:${reset} ${data.error.cause}`;
  }

  return output;
}

function formatValue(value: unknown): string {
  if (typeof value === "number") {
    // format bytes nicely
    if (value > 1024 * 1024) {
      return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    }

    if (value > 1024) {
      return `${(value / 1024).toFixed(1)}KB`;
    }

    return String(value);
  }

  if (typeof value === "string" && value.length > 20) {
    return `${value.substring(0, 20)}...`;
  }

  return String(value);
}

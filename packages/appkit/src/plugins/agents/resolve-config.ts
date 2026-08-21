import type { AgentsPluginConfig } from "../../core/agent/types";
import { createLogger } from "../../logging/logger";

const logger = createLogger("agents");

const APPROVAL_TIMEOUT_FLOOR_MS = 1_000;
const APPROVAL_TIMEOUT_DEFAULT_MS = 60_000;

/**
 * Effective approval policy with defaults applied. `timeoutMs` is clamped to a
 * 1s floor so a misconfigured value (`0`, negative, or `NaN`) can't degrade
 * into immediate auto-denial of every mutating tool call.
 *
 * The caller memoises the result, so the floor warning fires at most once per
 * plugin instance rather than on every chat stream.
 */
export function resolveApprovalPolicy(config: AgentsPluginConfig): {
  requireForDestructive: boolean;
  timeoutMs: number;
} {
  const cfg = config.approval ?? {};
  let timeoutMs = cfg.timeoutMs ?? APPROVAL_TIMEOUT_DEFAULT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < APPROVAL_TIMEOUT_FLOOR_MS) {
    logger.warn(
      "approval.timeoutMs=%s is below the %sms floor; using default %sms instead. Mutating tool calls would otherwise auto-deny before any UI could respond.",
      cfg.timeoutMs,
      APPROVAL_TIMEOUT_FLOOR_MS,
      APPROVAL_TIMEOUT_DEFAULT_MS,
    );
    timeoutMs = APPROVAL_TIMEOUT_DEFAULT_MS;
  }
  return {
    requireForDestructive: cfg.requireForDestructive ?? true,
    timeoutMs,
  };
}

/** Effective DoS limits with defaults applied. */
export function resolveLimits(config: AgentsPluginConfig): {
  maxConcurrentStreamsPerUser: number;
  maxToolCalls: number;
  maxSubAgentDepth: number;
  toolCallTimeoutMs: number;
} {
  const cfg = config.limits ?? {};
  return {
    maxConcurrentStreamsPerUser: cfg.maxConcurrentStreamsPerUser ?? 5,
    maxToolCalls: cfg.maxToolCalls ?? 50,
    maxSubAgentDepth: cfg.maxSubAgentDepth ?? 3,
    // 5 minutes is the floor for cold SQL Warehouse / long Genie /
    // long Lakebase calls. The previous PluginContext default of 30s
    // truncated legitimate analytics queries on cold compute.
    toolCallTimeoutMs: cfg.toolCallTimeoutMs ?? 300_000,
  };
}

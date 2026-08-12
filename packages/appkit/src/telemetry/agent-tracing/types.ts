import type { AgentEvent, AgentRemoteTraceEvent, AgentUsage } from "shared";

export interface CapturedTraceValue {
  value: string;
  originalBytes: number;
  sha256: string;
  truncated: boolean;
}

export interface CaptureTraceValueOptions {
  maxBytes?: number;
  redactKeys?: readonly string[];
}

export interface ConsumedAgentStream {
  text: string;
  usage: AgentUsage;
  remoteTrace?: AgentRemoteTraceEvent;
}

export type AgentTraceRoute = "chat" | "invocations" | "responses" | "runAgent";

export interface AgentTraceIdentity {
  appName: string;
  agentName: string;
  route: AgentTraceRoute;
  sessionId: string;
  userId: string;
  requestId: string;
  threadId: string;
}

export interface AgentTraceObserver {
  /** MLflow V4 identity when UC is active; otherwise the 32-hex OTel trace ID. */
  readonly traceId: string;
  onEvent(event: AgentEvent): void;
}

export interface AgentTraceResult<T> {
  value: T;
  traceId: string;
  usage: AgentUsage;
}

import type { AgentRemoteTraceEvent, AgentUsage } from "shared";

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

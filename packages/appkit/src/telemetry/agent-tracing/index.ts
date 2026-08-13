export {
  attachRemoteTraceLink,
  injectActiveTraceContext,
  type RemoteTraceReference,
  verifiedAgentRemoteTrace,
} from "./propagation";
export { captureTraceValue, normalizeFailureOutput } from "./serialization";
export {
  getActiveAgentTraceIdentity,
  resolveAgentTraceAppName,
  runWithAgentTrace,
} from "./tracer";
export type {
  AgentTraceObserver,
  CapturedTraceValue,
  CaptureTraceValueOptions,
  ConsumedAgentStream,
} from "./types";
export { AgentUsageAccumulator } from "./usage";

import type { ElementDescription } from "./lib/dom-utils";

export interface AgentInfo {
  id: string;
  label: string;
  mode: "spawn" | "stored" | "channel";
  available: boolean;
}

export interface Command {
  id: string;
  icon: string;
  tag: string;
  title: string;
  subtitle: string;
  run: () => Promise<void>;
}

export type DevtoolsView =
  | "commands"
  | "picked"
  | "performance"
  | "health"
  | "waterfall"
  | "streams"
  | "queries"
  | "console"
  | "hidden";

export interface PerformanceData {
  totalRequests: number;
  errorCount: number;
  thresholdMs: number;
  slowRequests: Array<{
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    timestamp: string;
    pluginName?: string;
    isError: boolean;
  }>;
  timing: {
    avg: number;
    p50: number;
    p95: number;
    max: number;
  } | null;
}

export interface PluginHealthEntry {
  pluginName: string;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  lastError?: {
    method: string;
    path: string;
    statusCode: number;
    timestamp: string;
  };
}

export interface StreamDebugEntry {
  pluginName: string;
  streamId: string;
  clientCount: number;
  eventCount: number;
  isCompleted: boolean;
  lastAccessAgo: string;
  lastAccessMs: number;
}

export interface StreamDebugData {
  totalActive: number;
  streams: StreamDebugEntry[];
}

export interface QueryEventEntry {
  queryKey: string;
  parameters: Record<string, unknown>;
  durationMs: number;
  cacheHit: boolean;
  isObo: boolean;
  executorKey: string;
  timestamp: string;
  error?: string;
}

export interface DevtoolsState {
  panelOpen: boolean;
  docked: boolean;
  dockedWidth: number;
  view: DevtoolsView;
  pickedElement: ElementDescription | undefined;
  userPrompt: string;
  latestBundle: any;
  latestPrompt: string;
  status: string;
  promptVisible: boolean;
  promptText: string;
  agentRunning: boolean;
  agentStreamLines: string[];
  agents: AgentInfo[];
  pillState: PillState | null;
  performanceData: PerformanceData | null;
  healthData: PluginHealthEntry[] | null;
  streamsData: StreamDebugData | null;
  queriesData: QueryEventEntry[] | null;
}

export interface PillState {
  label: string;
  text: string;
  status: "running" | "done" | "error";
}

import type { BasePlugin, BasePluginConfig, PluginEndpointMap } from "shared";

export interface IInspectorConfig extends BasePluginConfig {
  enabledByDefault?: boolean;
  bridgeTarget?: string;
  sourceRoot?: string;
  maxForwardPayloadBytes?: number;
  maxRecentEvents?: number;
  maxStoredSessions?: number;
  maxStoredEventsPerSession?: number;
}

export interface InspectorRuntimeConfig {
  enabledByDefault: boolean;
  bridgeTarget: string;
  persistKey: string;
  activationParam: string;
  sessionHeader: string;
}

export interface InspectorPluginMetadata {
  name: string;
  displayName: string;
  description: string;
  endpoints: PluginEndpointMap;
}

export interface InspectorRecentEvent {
  sessionId: string;
  requestId: string;
  streamId?: string;
  pluginName?: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  timestamp: string;
  isError: boolean;
}

export interface InspectorClientNetworkEvent {
  id: string;
  method: string;
  url: string;
  path: string;
  status?: number;
  timestamp: string;
  durationMs?: number;
}

export interface InspectorSourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
  componentName?: string;
}

export interface InspectorElementReference {
  domPath: string;
  selector?: string;
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  name?: string;
  type?: string;
  href?: string;
  text?: string;
  source?: InspectorSourceLocation;
  componentStack?: string[];
}

export interface InspectorClientAction {
  type: string;
  label: string;
  timestamp: string;
  element?: InspectorElementReference;
}

export interface InspectorConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  stack?: string;
}

export interface InspectorClientSnapshot {
  sessionId: string;
  url: string;
  title?: string;
  route?: string;
  selectedText?: string;
  selectedElement?: InspectorElementReference;
  pickedElement?: InspectorElementReference;
  userPrompt?: string;
  textExcerpt?: string;
  network?: InspectorClientNetworkEvent[];
  actions?: InspectorClientAction[];
  console?: InspectorConsoleEntry[];
}

export interface InspectorPluginMatch extends InspectorPluginMetadata {
  matchedBy: "pathname" | "network" | "none";
}

export interface InspectorContextBundle {
  generatedAt: string;
  sessionId: string;
  app: {
    appName: string;
    title: string;
    url: string;
    pathname: string;
    search: string;
  };
  page: {
    route: string;
    selectedText?: string;
    selectedElement?: InspectorElementReference;
    pickedElement?: InspectorElementReference;
    userPrompt?: string;
    textExcerpt?: string;
    recentActions: InspectorClientAction[];
  };
  plugin: InspectorPluginMatch | null;
  client: {
    recentNetwork: InspectorClientNetworkEvent[];
    recentConsole: InspectorConsoleEntry[];
  };
  server: {
    recentEvents: InspectorRecentEvent[];
  };
  runtime: {
    availablePlugins: InspectorPluginMetadata[];
  };
}

export interface InspectorPluginHealthEntry {
  pluginName: string;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  lastError?: InspectorRecentEvent;
}

export interface InspectorPerformanceEntry {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  timestamp: string;
  pluginName?: string;
  isError: boolean;
}

export interface InspectorStreamDebugEntry {
  pluginName: string;
  streamId: string;
  clientCount: number;
  eventCount: number;
  isCompleted: boolean;
  lastAccessAgo: string;
  lastAccessMs: number;
}

export interface InspectorQueryEvent {
  queryKey: string;
  parameters: Record<string, unknown>;
  durationMs: number;
  cacheHit: boolean;
  isObo: boolean;
  executorKey: string;
  timestamp: string;
  error?: string;
}

export interface InspectorPromptResponse {
  prompt: string;
  bundle: InspectorContextBundle;
}

export interface InspectorBridgeResponse {
  ok: boolean;
  status?: number;
  target: string;
}

export interface InspectorInternalConfig extends IInspectorConfig {
  plugins?: Record<string, BasePlugin>;
}

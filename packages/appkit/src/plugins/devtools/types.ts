import type { BasePlugin, BasePluginConfig, PluginEndpointMap } from "shared";

export interface IDevtoolsConfig extends BasePluginConfig {
  enabledByDefault?: boolean;
  bridgeTarget?: string;
  sourceRoot?: string;
  maxForwardPayloadBytes?: number;
  maxRecentEvents?: number;
  maxStoredSessions?: number;
  maxStoredEventsPerSession?: number;
}

export interface DevtoolsRuntimeConfig {
  enabledByDefault: boolean;
  bridgeTarget: string;
  persistKey: string;
  activationParam: string;
  sessionHeader: string;
}

export interface DevtoolsPluginMetadata {
  name: string;
  displayName: string;
  description: string;
  endpoints: PluginEndpointMap;
}

export interface DevtoolsRecentEvent {
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

export interface DevtoolsClientNetworkEvent {
  id: string;
  method: string;
  url: string;
  path: string;
  status?: number;
  timestamp: string;
  durationMs?: number;
}

export interface DevtoolsSourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
  componentName?: string;
}

export interface DevtoolsElementReference {
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
  source?: DevtoolsSourceLocation;
  componentStack?: string[];
}

export interface DevtoolsClientAction {
  type: string;
  label: string;
  timestamp: string;
  element?: DevtoolsElementReference;
}

export interface DevtoolsConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  stack?: string;
}

export interface DevtoolsClientSnapshot {
  sessionId: string;
  url: string;
  title?: string;
  route?: string;
  selectedText?: string;
  selectedElement?: DevtoolsElementReference;
  pickedElement?: DevtoolsElementReference;
  userPrompt?: string;
  textExcerpt?: string;
  network?: DevtoolsClientNetworkEvent[];
  actions?: DevtoolsClientAction[];
  console?: DevtoolsConsoleEntry[];
}

export interface DevtoolsPluginMatch extends DevtoolsPluginMetadata {
  matchedBy: "pathname" | "network" | "none";
}

export interface DevtoolsContextBundle {
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
    selectedElement?: DevtoolsElementReference;
    pickedElement?: DevtoolsElementReference;
    userPrompt?: string;
    textExcerpt?: string;
    recentActions: DevtoolsClientAction[];
  };
  plugin: DevtoolsPluginMatch | null;
  client: {
    recentNetwork: DevtoolsClientNetworkEvent[];
    recentConsole: DevtoolsConsoleEntry[];
  };
  server: {
    recentEvents: DevtoolsRecentEvent[];
  };
  runtime: {
    availablePlugins: DevtoolsPluginMetadata[];
  };
}

export interface DevtoolsPluginHealthEntry {
  pluginName: string;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  lastError?: DevtoolsRecentEvent;
}

export interface DevtoolsPerformanceEntry {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  timestamp: string;
  pluginName?: string;
  isError: boolean;
}

export interface DevtoolsStreamDebugEntry {
  pluginName: string;
  streamId: string;
  clientCount: number;
  eventCount: number;
  isCompleted: boolean;
  lastAccessAgo: string;
  lastAccessMs: number;
}

export interface DevtoolsQueryEvent {
  queryKey: string;
  parameters: Record<string, unknown>;
  durationMs: number;
  cacheHit: boolean;
  isObo: boolean;
  executorKey: string;
  timestamp: string;
  error?: string;
}

export interface DevtoolsPromptResponse {
  prompt: string;
  bundle: DevtoolsContextBundle;
}

export interface DevtoolsBridgeResponse {
  ok: boolean;
  status?: number;
  target: string;
}

export interface DevtoolsInternalConfig extends IDevtoolsConfig {
  plugins?: Record<string, BasePlugin>;
}

import type { BasePlugin, BasePluginConfig, PluginEndpointMap } from "shared";

export interface IInspectorConfig extends BasePluginConfig {
  enabledByDefault?: boolean;
  bridgeTarget?: string;
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
}

export interface InspectorClientAction {
  type: string;
  label: string;
  timestamp: string;
  element?: InspectorElementReference;
}

export interface InspectorClientSnapshot {
  sessionId: string;
  url: string;
  title?: string;
  route?: string;
  selectedText?: string;
  selectedElement?: InspectorElementReference;
  textExcerpt?: string;
  network?: InspectorClientNetworkEvent[];
  actions?: InspectorClientAction[];
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
    textExcerpt?: string;
    recentActions: InspectorClientAction[];
  };
  plugin: InspectorPluginMatch | null;
  client: {
    recentNetwork: InspectorClientNetworkEvent[];
  };
  server: {
    recentEvents: InspectorRecentEvent[];
  };
  runtime: {
    availablePlugins: InspectorPluginMetadata[];
  };
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

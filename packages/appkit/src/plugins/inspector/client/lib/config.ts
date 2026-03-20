/// <reference lib="dom" />

export interface InspectorConfig {
  enabledByDefault: boolean;
  bridgeTarget: string;
  persistKey: string;
  activationParam: string;
  sessionHeader: string;
}

export function readConfig(): InspectorConfig | null {
  const win = window as any;
  return win.__APPKIT_INSPECTOR_SERVER_CONFIG__ ?? win.__CONFIG__?.inspector ?? null;
}

export function checkActivation(config: InspectorConfig): boolean {
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get(config.activationParam);

  if (queryValue === "1") {
    localStorage.setItem(config.persistKey, "1");
  } else if (queryValue === "0") {
    localStorage.removeItem(config.persistKey);
  }

  return (
    queryValue === "1" ||
    (queryValue !== "0" &&
      (localStorage.getItem(config.persistKey) === "1" || config.enabledByDefault))
  );
}

export function getOrCreateSessionId(config: InspectorConfig): string {
  const key = config.persistKey + ":session-id";
  let sessionId = sessionStorage.getItem(key);
  if (!sessionId) {
    sessionId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "session-" + Math.random().toString(36).slice(2);
    sessionStorage.setItem(key, sessionId);
  }
  return sessionId;
}

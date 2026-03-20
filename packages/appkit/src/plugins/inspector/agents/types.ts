export interface InspectorAgentMessage {
  type: "status" | "error" | "done";
  content: string;
}

export interface InspectorAgentProvider {
  id: string;
  label: string;
  mode: "spawn" | "stored";
  available: boolean;
  run?(
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): AsyncGenerator<InspectorAgentMessage>;
}

export interface InspectorAgentInfo {
  id: string;
  label: string;
  mode: "spawn" | "stored";
  available: boolean;
}

export interface DevtoolsAgentMessage {
  type: "status" | "error" | "done";
  content: string;
}

export interface DevtoolsAgentProvider {
  id: string;
  label: string;
  mode: "spawn" | "stored";
  available: boolean;
  run?(
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): AsyncGenerator<DevtoolsAgentMessage>;
}

export interface DevtoolsAgentInfo {
  id: string;
  label: string;
  mode: "spawn" | "stored";
  available: boolean;
}

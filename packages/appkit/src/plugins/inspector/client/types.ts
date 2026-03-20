import type { ElementDescription } from "./lib/dom-utils";

export interface AgentInfo {
  id: string;
  label: string;
  mode: "spawn" | "stored";
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

export type InspectorView = "commands" | "picked" | "hidden";

export interface InspectorState {
  panelOpen: boolean;
  view: InspectorView;
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
}

export interface PillState {
  label: string;
  text: string;
  status: "running" | "done" | "error";
}

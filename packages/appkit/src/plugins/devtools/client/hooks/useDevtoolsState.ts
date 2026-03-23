import { useReducer } from "react";
import type { ElementDescription } from "../lib/dom-utils";
import type { DevtoolsState, AgentInfo, PerformanceData, PluginHealthEntry, StreamDebugData, QueryEventEntry } from "../types";

const DOCK_STORAGE_KEY = "appkit:devtools:docked";
const DOCK_WIDTH_KEY = "appkit:devtools:dock-width";
const DEFAULT_DOCK_WIDTH = 400;

type Action =
  | { type: "OPEN_PALETTE" }
  | { type: "CLOSE_PALETTE"; preserveState?: boolean }
  | { type: "SET_VIEW"; view: DevtoolsState["view"] }
  | { type: "SET_PICKED_ELEMENT"; element: ElementDescription | undefined }
  | { type: "SET_USER_PROMPT"; prompt: string }
  | { type: "SET_STATUS"; status: string }
  | { type: "SET_BUNDLE"; bundle: any; prompt?: string }
  | { type: "SHOW_PROMPT_TEXT"; text: string }
  | { type: "SET_AGENTS"; agents: AgentInfo[] }
  | { type: "AGENT_START"; label: string }
  | { type: "AGENT_STREAM"; line: string; pillText: string }
  | { type: "AGENT_FINISH" }
  | { type: "AGENT_ERROR"; message: string }
  | { type: "PILL_HIDE" }
  | { type: "SET_PERFORMANCE"; data: PerformanceData }
  | { type: "SET_HEALTH"; data: PluginHealthEntry[] }
  | { type: "SET_STREAMS"; data: StreamDebugData }
  | { type: "SET_QUERIES"; data: QueryEventEntry[] }
  | { type: "TOGGLE_DOCK" }
  | { type: "SET_DOCK_WIDTH"; width: number }
  | { type: "CLEAR_ALL" };

function readDockedState(): boolean {
  try { return localStorage.getItem(DOCK_STORAGE_KEY) === "1"; } catch { return false; }
}

function readDockedWidth(): number {
  try {
    const stored = localStorage.getItem(DOCK_WIDTH_KEY);
    if (stored) { const n = Number(stored); if (n >= 280 && n <= 800) return n; }
  } catch {}
  return DEFAULT_DOCK_WIDTH;
}

const initialState: DevtoolsState = {
  panelOpen: false,
  docked: readDockedState(),
  dockedWidth: readDockedWidth(),
  view: "commands",
  pickedElement: undefined,
  userPrompt: "",
  latestBundle: null,
  latestPrompt: "",
  status: "",
  promptVisible: false,
  promptText: "",
  agentRunning: false,
  agentStreamLines: [],
  agents: [],
  pillState: null,
  performanceData: null,
  healthData: null,
  streamsData: null,
  queriesData: null,
};

function reducer(state: DevtoolsState, action: Action): DevtoolsState {
  switch (action.type) {
    case "OPEN_PALETTE":
      return { ...state, panelOpen: true };
    case "CLOSE_PALETTE":
      if (action.preserveState) {
        return { ...state, panelOpen: false };
      }
      return {
        ...state,
        panelOpen: false,
        view: "commands",
        promptVisible: false,
        promptText: "",
      };
    case "SET_VIEW":
      return { ...state, view: action.view };
    case "SET_PICKED_ELEMENT":
      return { ...state, pickedElement: action.element };
    case "SET_USER_PROMPT":
      return { ...state, userPrompt: action.prompt };
    case "SET_STATUS":
      return { ...state, status: action.status };
    case "SET_BUNDLE":
      return {
        ...state,
        latestBundle: action.bundle,
        latestPrompt: action.prompt ?? state.latestPrompt,
      };
    case "SHOW_PROMPT_TEXT":
      return { ...state, promptVisible: true, promptText: action.text };
    case "SET_AGENTS":
      return { ...state, agents: action.agents };
    case "AGENT_START":
      return {
        ...state,
        agentRunning: true,
        agentStreamLines: [],
        panelOpen: false,
        pillState: {
          label: action.label,
          text: "Starting…",
          status: "running",
        },
      };
    case "AGENT_STREAM":
      return {
        ...state,
        agentStreamLines: [...state.agentStreamLines, action.line],
        pillState: state.pillState
          ? { ...state.pillState, text: action.pillText }
          : null,
      };
    case "AGENT_FINISH":
      return {
        ...state,
        agentRunning: false,
        pillState: state.pillState
          ? { ...state.pillState, text: "Completed", status: "done" }
          : null,
      };
    case "AGENT_ERROR":
      return {
        ...state,
        agentRunning: false,
        pillState: state.pillState
          ? { ...state.pillState, text: action.message, status: "error" }
          : null,
      };
    case "PILL_HIDE":
      return { ...state, pillState: null };
    case "SET_PERFORMANCE":
      return { ...state, performanceData: action.data };
    case "SET_HEALTH":
      return { ...state, healthData: action.data };
    case "SET_STREAMS":
      return { ...state, streamsData: action.data };
    case "SET_QUERIES":
      return { ...state, queriesData: action.data };
    case "TOGGLE_DOCK": {
      const docked = !state.docked;
      try { localStorage.setItem(DOCK_STORAGE_KEY, docked ? "1" : "0"); } catch {}
      return { ...state, docked, panelOpen: true };
    }
    case "SET_DOCK_WIDTH": {
      const width = Math.max(280, Math.min(800, action.width));
      try { localStorage.setItem(DOCK_WIDTH_KEY, String(width)); } catch {}
      return { ...state, dockedWidth: width };
    }
    case "CLEAR_ALL":
      return {
        ...initialState,
        agents: state.agents,
      };
    default:
      return state;
  }
}

export function useDevtoolsState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  return { state, dispatch };
}

export type DevtoolsDispatch = ReturnType<
  typeof useDevtoolsState
>["dispatch"];

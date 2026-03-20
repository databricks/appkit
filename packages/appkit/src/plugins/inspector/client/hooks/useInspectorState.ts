import { useReducer } from "react";
import type { ElementDescription } from "../lib/dom-utils";
import type { InspectorState, AgentInfo, PillState } from "../types";

type Action =
  | { type: "OPEN_PALETTE" }
  | { type: "CLOSE_PALETTE"; preserveState?: boolean }
  | { type: "SET_VIEW"; view: InspectorState["view"] }
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
  | { type: "CLEAR_ALL" };

const initialState: InspectorState = {
  panelOpen: false,
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
};

function reducer(state: InspectorState, action: Action): InspectorState {
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
          text: "Starting\u2026",
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
    case "CLEAR_ALL":
      return {
        ...initialState,
        agents: state.agents,
      };
    default:
      return state;
  }
}

export function useInspectorState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  return { state, dispatch };
}

export type InspectorDispatch = ReturnType<
  typeof useInspectorState
>["dispatch"];

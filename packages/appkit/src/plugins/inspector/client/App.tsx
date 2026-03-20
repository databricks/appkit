import React, { useEffect, useCallback, useRef } from "react";
import type { InspectorConfig } from "./lib/config";
import type { NetworkState } from "./lib/network-interceptor";
import type { InspectorApi } from "./lib/api";
import { createApi } from "./lib/api";
import { summarizeText, describeElement } from "./lib/dom-utils";
import { useInspectorState } from "./hooks/useInspectorState";
import type { ElementDescription } from "./lib/dom-utils";
import { CommandPalette } from "./components/CommandPalette";
import { ElementPicker } from "./components/ElementPicker";
import { AgentPill } from "./components/AgentPill";

interface AppProps {
  config: InspectorConfig;
  sessionId: string;
  networkState: NetworkState;
  shadowRoot: ShadowRoot;
}

export function App({ config, sessionId, networkState, shadowRoot }: AppProps) {
  const { state, dispatch } = useInspectorState();
  const apiRef = useRef<InspectorApi>(
    createApi(config.sessionHeader, sessionId),
  );
  const cachedSelectionRef = useRef<{
    text: string;
    element: ElementDescription | undefined;
  }>({ text: "", element: undefined });
  const pickModeRef = useRef(false);

  const getSelectedText = useCallback(() => {
    const selection = window.getSelection();
    return selection ? summarizeText(selection.toString(), 280) : "";
  }, []);

  const getSelectedElement = useCallback(():
    | ElementDescription
    | undefined => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return undefined;
    const anchorNode = selection.anchorNode || selection.focusNode;
    if (!anchorNode) return undefined;
    const element =
      anchorNode.nodeType === Node.ELEMENT_NODE
        ? (anchorNode as Element)
        : anchorNode.parentElement;
    return describeElement(element);
  }, []);

  const createSnapshot = useCallback(() => {
    const hasPicked = !!state.pickedElement && !!state.userPrompt;
    return {
      sessionId,
      url: window.location.href,
      title: document.title || "",
      route: window.location.pathname + window.location.search,
      selectedText: hasPicked
        ? undefined
        : state.panelOpen
          ? cachedSelectionRef.current.text
          : getSelectedText(),
      selectedElement: hasPicked
        ? undefined
        : state.panelOpen
          ? cachedSelectionRef.current.element
          : getSelectedElement(),
      pickedElement: state.pickedElement || undefined,
      userPrompt: state.userPrompt || undefined,
      textExcerpt: hasPicked
        ? undefined
        : summarizeText(document.body?.innerText || "", 1600),
      network: hasPicked ? [] : networkState.recentNetwork.slice(0, 20),
      actions: hasPicked ? [] : networkState.recentActions.slice(0, 20),
    };
  }, [
    sessionId,
    state.pickedElement,
    state.userPrompt,
    state.panelOpen,
    networkState,
    getSelectedText,
    getSelectedElement,
  ]);

  const openPalette = useCallback(async () => {
    cachedSelectionRef.current = {
      text: getSelectedText(),
      element: getSelectedElement(),
    };
    dispatch({ type: "OPEN_PALETTE" });
    dispatch({ type: "SET_VIEW", view: "commands" });

    if (!state.latestBundle) {
      try {
        dispatch({ type: "SET_STATUS", status: "Collecting screen context\u2026" });
        const bundle = await apiRef.current.requestJson(
          "/api/inspector/context",
          createSnapshot(),
        );
        dispatch({ type: "SET_BUNDLE", bundle });
        dispatch({ type: "SET_STATUS", status: "Context ready." });
      } catch (error) {
        dispatch({
          type: "SET_STATUS",
          status:
            error instanceof Error
              ? error.message
              : "Failed to load context.",
        });
      }
    }
  }, [
    getSelectedText,
    getSelectedElement,
    state.latestBundle,
    createSnapshot,
    dispatch,
  ]);

  const closePalette = useCallback(
    (preserveState = false) => {
      dispatch({ type: "CLOSE_PALETTE", preserveState });
    },
    [dispatch],
  );

  const startPickMode = useCallback(() => {
    closePalette();
    pickModeRef.current = true;
  }, [closePalette]);

  const onElementPicked = useCallback(
    async (element: ElementDescription) => {
      pickModeRef.current = false;
      dispatch({ type: "SET_PICKED_ELEMENT", element });
      dispatch({ type: "OPEN_PALETTE" });
      dispatch({ type: "SET_VIEW", view: "picked" });
      try {
        const data = await apiRef.current.fetchJson("/api/inspector/agents");
        dispatch({ type: "SET_AGENTS", agents: data.agents || [] });
      } catch {
        dispatch({
          type: "SET_AGENTS",
          agents: [
            {
              id: "clipboard",
              label: "Copy prompt",
              mode: "stored" as const,
              available: true,
            },
          ],
        });
      }
    },
    [dispatch],
  );

  const sendToAgent = useCallback(
    async (agentId: string) => {
      const userPrompt = state.userPrompt.trim();
      if (!userPrompt && agentId !== "clipboard") {
        dispatch({
          type: "SET_STATUS",
          status: "Type what you want the agent to do.",
        });
        return;
      }

      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return;

      try {
        dispatch({ type: "SET_STATUS", status: "Preparing context\u2026" });
        const promptResponse = await apiRef.current.requestJson(
          "/api/inspector/prompt",
          createSnapshot(),
        );
        dispatch({
          type: "SET_BUNDLE",
          bundle: promptResponse.bundle,
          prompt: promptResponse.prompt,
        });

        if (agentId === "clipboard") {
          await navigator.clipboard.writeText(promptResponse.prompt);
          dispatch({
            type: "SET_STATUS",
            status: "Prompt copied to clipboard.",
          });
          dispatch({ type: "SHOW_PROMPT_TEXT", text: promptResponse.prompt });
          return;
        }

        if (agent.mode === "stored") {
          await apiRef.current.requestJson("/api/inspector/agent/run", {
            agentId,
            prompt: promptResponse.prompt,
            bundle: promptResponse.bundle,
          });
          dispatch({
            type: "SET_STATUS",
            status: `Context stored. Run appkit inspect prompt in ${agent.label}.`,
          });
          dispatch({ type: "SHOW_PROMPT_TEXT", text: promptResponse.prompt });
          return;
        }

        dispatch({ type: "AGENT_START", label: agent.label });

        const response = await fetch("/api/inspector/agent/run", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [config.sessionHeader]: sessionId,
          },
          body: JSON.stringify({
            agentId,
            prompt: promptResponse.prompt,
          }),
        });

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let hadError = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "status") {
                dispatch({
                  type: "AGENT_STREAM",
                  line: summarizeText(event.content, 200),
                  pillText: summarizeText(event.content, 60),
                });
              } else if (event.type === "error") {
                hadError = true;
                dispatch({
                  type: "AGENT_ERROR",
                  message: summarizeText(event.content, 60),
                });
              } else if (event.type === "done" && !hadError) {
                dispatch({ type: "AGENT_FINISH" });
              }
            } catch {}
          }
        }

        if (!hadError) dispatch({ type: "AGENT_FINISH" });
      } catch (error) {
        dispatch({
          type: "AGENT_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to send to agent.",
        });
      }
    },
    [
      state.userPrompt,
      state.agents,
      createSnapshot,
      config.sessionHeader,
      sessionId,
      dispatch,
    ],
  );

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        if (pickModeRef.current) pickModeRef.current = false;
        if (state.panelOpen) {
          closePalette();
        } else {
          await openPalette();
        }
      }

      if (!state.panelOpen) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [state.panelOpen, openPalette, closePalette]);

  useEffect(() => {
    const handler = () => {
      dispatch({ type: "SET_BUNDLE", bundle: null });
    };
    window.addEventListener("popstate", handler);
    window.addEventListener("hashchange", handler);
    return () => {
      window.removeEventListener("popstate", handler);
      window.removeEventListener("hashchange", handler);
    };
  }, [dispatch]);

  const loadBundle = useCallback(async () => {
    const bundle = await apiRef.current.requestJson(
      "/api/inspector/context",
      createSnapshot(),
    );
    dispatch({ type: "SET_BUNDLE", bundle });
    return bundle;
  }, [createSnapshot, dispatch]);

  const loadPrompt = useCallback(async () => {
    const bundle = await loadBundle();
    const response = await apiRef.current.requestJson(
      "/api/inspector/prompt",
      { bundle },
    );
    dispatch({
      type: "SET_BUNDLE",
      bundle: response.bundle,
      prompt: response.prompt,
    });
    dispatch({ type: "SHOW_PROMPT_TEXT", text: response.prompt });
    return response;
  }, [loadBundle, dispatch]);

  return (
    <>
      <CommandPalette
        state={state}
        dispatch={dispatch}
        config={config}
        networkState={networkState}
        onStartPickMode={startPickMode}
        onSendToAgent={sendToAgent}
        onLoadBundle={loadBundle}
        onLoadPrompt={loadPrompt}
        onClose={() => closePalette()}
      />
      <ElementPicker
        active={pickModeRef.current}
        shadowRoot={shadowRoot}
        onPick={onElementPicked}
        onCancel={() => {
          pickModeRef.current = false;
        }}
      />
      <AgentPill
        pillState={state.pillState}
        onHide={() => dispatch({ type: "PILL_HIDE" })}
        onClick={() => {
          dispatch({ type: "PILL_HIDE" });
          dispatch({ type: "OPEN_PALETTE" });
          dispatch({ type: "SET_VIEW", view: "picked" });
        }}
      />
    </>
  );
}

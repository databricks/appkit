import React, { useState, useCallback, useEffect, useRef } from "react";
import type { InspectorState, Command } from "../types";
import type { InspectorDispatch } from "../hooks/useInspectorState";
import type { InspectorConfig } from "../lib/config";
import type { NetworkState } from "../lib/network-interceptor";
import { summarizeText } from "../lib/dom-utils";

interface Props {
  state: InspectorState;
  dispatch: InspectorDispatch;
  config: InspectorConfig;
  networkState: NetworkState;
  onStartPickMode: () => void;
  onSendToAgent: (agentId: string) => Promise<void>;
  onLoadBundle: () => Promise<any>;
  onLoadPrompt: () => Promise<any>;
  onClose: () => void;
}

const ICONS = {
  explain:
    "<svg viewBox='0 0 16 16' fill='currentColor'><path d='M8 1l2 5 5 2-5 2-2 5-2-5-5-2 5-2z'/></svg>",
  copy: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><rect x='4' y='4' width='8' height='10' rx='1.5'/><path d='M6 4V2.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V4'/></svg>",
  bridge:
    "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M3 13L13 3M13 3H6M13 3v7'/></svg>",
  pick: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M5 1v14l4-4h5'/></svg>",
  clear:
    "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M2 2l12 12M14 2L2 14'/></svg>",
  search:
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='8'/><line x1='21' y1='21' x2='16.65' y2='16.65'/></svg>",
};

export function CommandPalette({
  state,
  dispatch,
  config,
  networkState,
  onStartPickMode,
  onSendToAgent,
  onLoadBundle,
  onLoadPrompt,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.panelOpen && state.view === "commands" && inputRef.current) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    if (
      state.panelOpen &&
      state.view === "picked" &&
      promptInputRef.current
    ) {
      requestAnimationFrame(() => promptInputRef.current?.focus());
    }
  }, [state.panelOpen, state.view]);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [state.agentStreamLines]);

  const commands: Command[] = [
    {
      id: "explain",
      icon: ICONS.explain,
      tag: "Prompt",
      title: "Explain this screen",
      subtitle:
        "Generate a prompt with browser context and correlated server events.",
      run: async () => {
        dispatch({ type: "SET_STATUS", status: "Generating prompt\u2026" });
        await onLoadPrompt();
        dispatch({ type: "SET_STATUS", status: "Prompt ready." });
      },
    },
    {
      id: "copy",
      icon: ICONS.copy,
      tag: "Clipboard",
      title: "Copy AI prompt",
      subtitle: "Copy the generated prompt to your clipboard.",
      run: async () => {
        dispatch({
          type: "SET_STATUS",
          status: "Preparing prompt to copy\u2026",
        });
        if (!state.latestPrompt) await onLoadPrompt();
        await navigator.clipboard.writeText(state.latestPrompt);
        dispatch({
          type: "SET_STATUS",
          status: "Prompt copied to clipboard.",
        });
      },
    },
    {
      id: "bridge",
      icon: ICONS.bridge,
      tag: "Localhost",
      title: "Send to local bridge",
      subtitle:
        "Forward the redacted context bundle to your localhost bridge.",
      run: async () => {
        dispatch({
          type: "SET_STATUS",
          status: "Forwarding context to local bridge\u2026",
        });
        await onLoadBundle();
      },
    },
    {
      id: "pick",
      icon: ICONS.pick,
      tag: "Element",
      title: "Pick an element",
      subtitle:
        "Select a UI element to inspect or send to your coding agent.",
      run: async () => {
        onStartPickMode();
      },
    },
    {
      id: "clear",
      icon: ICONS.clear,
      tag: "Reset",
      title: "Clear context",
      subtitle:
        "Reset recorded network calls, actions, and cached prompts.",
      run: async () => {
        networkState.recentNetwork.length = 0;
        networkState.recentActions.length = 0;
        dispatch({ type: "CLEAR_ALL" });
        dispatch({
          type: "SET_STATUS",
          status: "Context cleared \u2014 recording from now.",
        });
      },
    },
  ];

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.title.toLowerCase().includes(query.toLowerCase()) ||
          c.subtitle.toLowerCase().includes(query.toLowerCase()),
      )
    : commands;

  const runSelected = useCallback(async () => {
    const cmd = filtered[selectedIndex];
    if (!cmd) return;
    try {
      await cmd.run();
    } catch (e) {
      dispatch({
        type: "SET_STATUS",
        status: e instanceof Error ? e.message : "Command failed.",
      });
    }
  }, [filtered, selectedIndex, dispatch]);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (state.view !== "commands") return;
      if (e.key === "ArrowDown" && filtered.length > 0) {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp" && filtered.length > 0) {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        await runSelected();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [state.view, filtered, runSelected, onClose],
  );

  const handlePromptKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const spawnAgent = state.agents.find(
          (a) => a.mode === "spawn" && a.available,
        );
        await onSendToAgent(spawnAgent ? spawnAgent.id : "clipboard");
      } else if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "SET_VIEW", view: "commands" });
        dispatch({ type: "SET_PICKED_ELEMENT", element: undefined });
        dispatch({ type: "SET_USER_PROMPT", prompt: "" });
      }
    },
    [state.agents, onSendToAgent, dispatch],
  );

  const pluginName = state.latestBundle?.plugin
    ? `${state.latestBundle.plugin.displayName} (${state.latestBundle.plugin.name})`
    : "Unknown";

  const selectedTextLabel =
    state.latestBundle?.page?.selectedText ||
    (state.panelOpen ? "" : "") ||
    "None";
  const selectedElementLabel = state.latestBundle?.page?.selectedElement
    ? summarizeText(
        state.latestBundle.page.selectedElement.selector ||
          state.latestBundle.page.selectedElement.domPath ||
          state.latestBundle.page.selectedElement.tagName,
        70,
      )
    : "None";

  if (!state.panelOpen) return null;

  return (
    <div className={`overlay${state.panelOpen ? " open" : ""}`}>
      <div className="backdrop" onClick={onClose} />
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="AppKit Inspector"
        onKeyDown={state.view === "commands" ? handleKeyDown : undefined}
      >
        <div className="header">
          <div className="topbar">
            <div className="brand">
              <span className="brand-mark" />
              <span className="brand-label">Inspector</span>
            </div>
            <span className="bridge-pill">
              {summarizeText(config.bridgeTarget || "", 36)}
            </span>
          </div>
          {state.view === "commands" && (
            <div className="search-row">
              <span
                className="search-icon"
                dangerouslySetInnerHTML={{ __html: ICONS.search }}
              />
              <input
                ref={inputRef}
                className="command-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Type a command\u2026"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
              />
              <span className="shortcut-pills">
                <kbd>{"\u2318"}</kbd>
                <kbd>K</kbd>
              </span>
            </div>
          )}
        </div>

        <div className="body">
          {state.view === "commands" && (
            <>
              <div className="section-label">Actions</div>
              <div className="command-list">
                {filtered.length === 0 ? (
                  <div className="empty-state">
                    No inspector commands match your search.
                  </div>
                ) : (
                  filtered.map((cmd, i) => (
                    <button
                      key={cmd.id}
                      type="button"
                      className={`command-item${i === selectedIndex ? " active" : ""}`}
                      onClick={async () => {
                        setSelectedIndex(i);
                        await cmd.run();
                      }}
                    >
                      <span className="command-main">
                        <span
                          className="command-icon"
                          dangerouslySetInnerHTML={{ __html: cmd.icon }}
                        />
                        <span className="command-copy">
                          <span className="command-title">{cmd.title}</span>
                          <span className="command-subtitle">
                            {cmd.subtitle}
                          </span>
                        </span>
                      </span>
                      <span className="command-meta">
                        <span className="command-tag">{cmd.tag}</span>
                        <kbd>Enter</kbd>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          {state.view === "picked" && state.pickedElement && (
            <div>
              <div className="section-label">Picked Element</div>
              <div className="picked-element-card">
                {state.pickedElement.source?.componentName ? (
                  <span className="picked-tag">
                    &lt;{state.pickedElement.source.componentName}&gt;
                  </span>
                ) : state.pickedElement.componentStack?.[0] ? (
                  <span className="picked-tag">
                    &lt;{state.pickedElement.componentStack[0]}&gt;
                  </span>
                ) : (
                  <span className="picked-tag">
                    &lt;{state.pickedElement.tagName}&gt;{" "}
                    {state.pickedElement.selector || state.pickedElement.domPath || ""}
                  </span>
                )}
                {state.pickedElement.source && (
                  <span className="picked-detail" style={{ color: "#818cf8" }}>
                    {state.pickedElement.source.fileName}:{state.pickedElement.source.lineNumber}
                  </span>
                )}
                {state.pickedElement.componentStack && state.pickedElement.componentStack.length > 0 && (
                  <span className="picked-detail">
                    {state.pickedElement.componentStack.join(" > ")}
                  </span>
                )}
                {state.pickedElement.text && (
                  <span className="picked-detail">
                    "{summarizeText(state.pickedElement.text, 80)}"
                  </span>
                )}
              </div>
              <div className="section-label" style={{ marginTop: 6 }}>
                What should change?
              </div>
              <div className="prompt-input-row">
                <input
                  ref={promptInputRef}
                  className="command-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="e.g. make this button larger, fix the alignment\u2026"
                  value={state.userPrompt}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_USER_PROMPT",
                      prompt: e.target.value,
                    })
                  }
                  onKeyDown={handlePromptKeyDown}
                />
              </div>
              <div className="agent-buttons">
                {state.agents
                  .filter((a) => a.available)
                  .map((agent) => (
                    <button
                      key={agent.id}
                      className={`agent-btn${agent.mode === "spawn" ? " primary" : ""}`}
                      disabled={state.agentRunning}
                      onClick={() => onSendToAgent(agent.id)}
                    >
                      {agent.label}
                    </button>
                  ))}
              </div>
              {state.agentStreamLines.length > 0 && (
                <div className="agent-stream-output" ref={streamRef}>
                  {state.agentStreamLines.join("\n")}
                </div>
              )}
            </div>
          )}

          <div className="divider" />
          <div className="summary">
            <div>
              <strong>Route</strong>
              {summarizeText(
                window.location.pathname + window.location.search,
                90,
              )}
            </div>
            <div>
              <strong>Likely plugin</strong>
              {summarizeText(pluginName, 90)}
            </div>
            <div>
              <strong>Recent client calls</strong>
              {String(networkState.recentNetwork.length)}
            </div>
            <div>
              <strong>Recent actions</strong>
              {String(networkState.recentActions.length)}
            </div>
            <div>
              <strong>Selected text</strong>
              {summarizeText(selectedTextLabel, 90) || "None"}
            </div>
            <div>
              <strong>Selected element</strong>
              {selectedElementLabel}
            </div>
          </div>
          {state.status && (
            <div className="status">
              {state.status.includes("\u2026") && (
                <span className="status-dot" />
              )}
              {state.status}
            </div>
          )}
          {state.promptVisible && (
            <div className="prompt-shell visible">
              <div className="section-label">Generated Prompt</div>
              <textarea
                className="prompt"
                value={state.promptText}
                readOnly
                placeholder="Prompt will appear here\u2026"
              />
            </div>
          )}
        </div>

        <div className="footer">
          <div className="footer-hints">
            <span className="hint">
              <kbd>{"\u2191"}</kbd>
              <kbd>{"\u2193"}</kbd> Navigate
            </span>
            <span className="hint">
              <kbd>{"\u21B5"}</kbd> Run
            </span>
            <span className="hint">
              <kbd>esc</kbd> Close
            </span>
          </div>
          <span className="meta-link">?inspect=0 to disable</span>
        </div>
      </div>
    </div>
  );
}

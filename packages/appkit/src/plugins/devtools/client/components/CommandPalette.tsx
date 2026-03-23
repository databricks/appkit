import React, { useState, useCallback, useEffect, useRef } from "react";
import type { DevtoolsState, Command } from "../types";
import type { DevtoolsDispatch } from "../hooks/useDevtoolsState";
import type { DevtoolsConfig } from "../lib/config";
import type { ConsoleState } from "../lib/console-interceptor";
import type { NetworkState } from "../lib/network-interceptor";
import { summarizeText } from "../lib/dom-utils";

interface Props {
  state: DevtoolsState;
  dispatch: DevtoolsDispatch;
  config: DevtoolsConfig;
  networkState: NetworkState;
  consoleState: ConsoleState;
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
  perf: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M1 14l4-6 3 3 4-5 3 4'/></svg>",
  health:
    "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z'/><path d='M8 5v3l2 2'/></svg>",
  waterfall:
    "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M1 3h6M3 6h8M2 9h5M4 12h10'/></svg>",
  streams:
    "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M2 4h12M2 8h12M2 12h12'/><circle cx='5' cy='4' r='1.5' fill='currentColor'/><circle cx='10' cy='8' r='1.5' fill='currentColor'/><circle cx='7' cy='12' r='1.5' fill='currentColor'/></svg>",
  queries:
    "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M2 3h12v10H2z'/><path d='M2 6h12'/><path d='M6 6v7'/></svg>",
  clear:
    "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M2 2l12 12M14 2L2 14'/></svg>",
  search:
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='8'/><line x1='21' y1='21' x2='16.65' y2='16.65'/></svg>",
  back: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M10 2L4 8l6 6'/></svg>",
  dock: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><rect x='1' y='1' width='14' height='14' rx='2'/><path d='M10 1v14'/></svg>",
  undock: "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='10' height='10' rx='2'/></svg>",
};

export function CommandPalette({
  state,
  dispatch,
  config,
  networkState,
  consoleState,
  onStartPickMode,
  onSendToAgent,
  onLoadBundle,
  onLoadPrompt,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedStream, setExpandedStream] = useState<string | null>(null);
  const [streamEvents, setStreamEvents] = useState<Array<{ id: string; type: string; data: unknown; timestamp: number }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startX = e.clientX;
      const startWidth = state.dockedWidth;

      const onMove = (moveEvent: MouseEvent) => {
        if (!resizingRef.current) return;
        const delta = startX - moveEvent.clientX;
        dispatch({ type: "SET_DOCK_WIDTH", width: startWidth + delta });
      };
      const onUp = () => {
        resizingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [state.dockedWidth, dispatch],
  );

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

  useEffect(() => {
    if (!commandListRef.current || state.view !== "commands") return;
    const active = commandListRef.current.children[selectedIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, state.view]);

  const toggleStreamExpand = useCallback(async (pluginName: string, streamId: string) => {
    const key = `${pluginName}:${streamId}`;
    if (expandedStream === key) {
      setExpandedStream(null);
      setStreamEvents([]);
      return;
    }
    setExpandedStream(key);
    try {
      const data = await fetch(
        `/api/devtools/stream-events?plugin=${encodeURIComponent(pluginName)}&streamId=${encodeURIComponent(streamId)}`,
        { headers: { [config.sessionHeader]: "" } },
      ).then((r) => r.json());
      setStreamEvents(data.events || []);
    } catch {
      setStreamEvents([]);
    }
  }, [expandedStream, config.sessionHeader]);

  useEffect(() => {
    if (!expandedStream || state.view !== "streams") {
      setStreamEvents([]);
      setExpandedStream(null);
      return;
    }
    const [pluginName, ...rest] = expandedStream.split(":");
    const streamId = rest.join(":");
    const poll = async () => {
      try {
        const data = await fetch(
          `/api/devtools/stream-events?plugin=${encodeURIComponent(pluginName)}&streamId=${encodeURIComponent(streamId)}`,
          { headers: { [config.sessionHeader]: "" } },
        ).then((r) => r.json());
        setStreamEvents(data.events || []);
      } catch {}
    };
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [expandedStream, state.view, config.sessionHeader]);

  useEffect(() => {
    const pollableViews = ["streams", "queries", "performance", "health"];
    if (!state.panelOpen || !pollableViews.includes(state.view)) return;

    const poll = async () => {
      try {
        if (state.view === "streams") {
          const data = await fetch("/api/devtools/streams", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_STREAMS", data });
        } else if (state.view === "queries") {
          const data = await fetch("/api/devtools/queries", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_QUERIES", data: data.queries || [] });
        } else if (state.view === "performance") {
          const data = await fetch("/api/devtools/performance", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_PERFORMANCE", data });
        } else if (state.view === "health") {
          const data = await fetch("/api/devtools/health-dashboard", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_HEALTH", data: data.plugins || [] });
        }
      } catch {}
    };

    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [state.panelOpen, state.view, config.sessionHeader, dispatch]);

  const commands: Command[] = [
    {
      id: "explain",
      icon: ICONS.explain,
      tag: "Prompt",
      title: "Explain this screen",
      subtitle:
        "Generate a prompt with browser context and correlated server events.",
      run: async () => {
        dispatch({ type: "SET_STATUS", status: "Generating prompt…" });
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
          status: "Preparing prompt to copy…",
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
      tag: "Agent",
      title: "Send to agent",
      subtitle:
        "Export screen context to your local agent bridge for AI-assisted debugging.",
      run: async () => {
        dispatch({
          type: "SET_STATUS",
          status: "Forwarding context to local bridge…",
        });
        const bundle = await onLoadBundle();
        const response = await fetch("/api/devtools/bridge", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [config.sessionHeader]: "",
          },
          body: JSON.stringify({ bundle }),
        }).then((r) => r.json());
        if (response?.ok) {
          networkState.recentNetwork.length = 0;
          networkState.recentActions.length = 0;
          consoleState.recentEntries.length = 0;
          dispatch({ type: "CLEAR_ALL" });
          dispatch({
            type: "SET_STATUS",
            status: "Context sent to local bridge. Recordings cleared.",
          });
        } else {
          dispatch({
            type: "SET_STATUS",
            status: "Bridge did not accept the payload.",
          });
        }
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
      id: "performance",
      icon: ICONS.perf,
      tag: "Perf",
      title: "Performance spotlight",
      subtitle:
        "Show slow requests, latency percentiles, and error counts.",
      run: async () => {
        dispatch({ type: "SET_STATUS", status: "Loading performance data…" });
        try {
          const data = await fetch("/api/devtools/performance", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_PERFORMANCE", data });
          dispatch({ type: "SET_VIEW", view: "performance" });
          dispatch({ type: "SET_STATUS", status: "" });
        } catch {
          dispatch({ type: "SET_STATUS", status: "Failed to load performance data." });
        }
      },
    },
    {
      id: "health",
      icon: ICONS.health,
      tag: "Health",
      title: "Plugin health",
      subtitle:
        "Per-plugin request counts, error rates, and latency breakdown.",
      run: async () => {
        dispatch({ type: "SET_STATUS", status: "Loading plugin health…" });
        try {
          const data = await fetch("/api/devtools/health-dashboard", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_HEALTH", data: data.plugins || [] });
          dispatch({ type: "SET_VIEW", view: "health" });
          dispatch({ type: "SET_STATUS", status: "" });
        } catch {
          dispatch({ type: "SET_STATUS", status: "Failed to load health data." });
        }
      },
    },
    {
      id: "waterfall",
      icon: ICONS.waterfall,
      tag: "Network",
      title: "Network waterfall",
      subtitle:
        "Visual timeline of recent client-side HTTP requests.",
      run: async () => {
        dispatch({ type: "SET_VIEW", view: "waterfall" });
        dispatch({ type: "SET_STATUS", status: "" });
      },
    },
    {
      id: "streams",
      icon: ICONS.streams,
      tag: "SSE",
      title: "SSE stream debugger",
      subtitle:
        "View active Server-Sent Event streams across all plugins.",
      run: async () => {
        dispatch({ type: "SET_STATUS", status: "Loading stream data…" });
        try {
          const data = await fetch("/api/devtools/streams", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_STREAMS", data });
          dispatch({ type: "SET_VIEW", view: "streams" });
          dispatch({ type: "SET_STATUS", status: "" });
        } catch {
          dispatch({ type: "SET_STATUS", status: "Failed to load stream data." });
        }
      },
    },
    {
      id: "queries",
      icon: ICONS.queries,
      tag: "SQL",
      title: "Query inspector",
      subtitle:
        "Recent analytics SQL queries with cache hits, timing, and parameters.",
      run: async () => {
        dispatch({ type: "SET_STATUS", status: "Loading query data…" });
        try {
          const data = await fetch("/api/devtools/queries", {
            headers: { [config.sessionHeader]: "" },
          }).then((r) => r.json());
          dispatch({ type: "SET_QUERIES", data: data.queries || [] });
          dispatch({ type: "SET_VIEW", view: "queries" });
          dispatch({ type: "SET_STATUS", status: "" });
        } catch {
          dispatch({ type: "SET_STATUS", status: "Failed to load query data." });
        }
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
        consoleState.recentEntries.length = 0;
        dispatch({ type: "CLEAR_ALL" });
        dispatch({
          type: "SET_STATUS",
          status: "Context cleared — recording from now.",
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
      if (e.key === "Escape") {
        e.preventDefault();
        if (state.view !== "commands" && state.view !== "picked") {
          dispatch({ type: "SET_VIEW", view: "commands" });
        } else {
          onClose();
        }
        return;
      }
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
      }
    },
    [state.view, filtered, runSelected, onClose, dispatch],
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

  const selectedElementLabel = state.latestBundle?.page?.selectedElement
    ? summarizeText(
        state.latestBundle.page.selectedElement.selector ||
          state.latestBundle.page.selectedElement.domPath ||
          state.latestBundle.page.selectedElement.tagName,
        70,
      )
    : "None";

  if (!state.panelOpen) return null;

  const overlayClass = state.docked
    ? "overlay open docked"
    : `overlay${state.panelOpen ? " open" : ""}`;

  const paletteStyle = state.docked
    ? { width: `${state.dockedWidth}px` }
    : undefined;

  return (
    <div className={overlayClass}>
      {!state.docked && <div className="backdrop" onClick={onClose} />}
      <div
        className={`palette${state.docked ? " palette-docked" : ""}`}
        role="dialog"
        aria-modal={!state.docked}
        aria-label="AppKit DevTools"
        onKeyDown={handleKeyDown}
        style={paletteStyle}
      >
        {state.docked && (
          <div className="dock-resize-handle" onMouseDown={onResizeStart} />
        )}
        <div className="header">
          <div className="topbar">
            <div className="brand">
              <span className="brand-mark" />
              <span className="brand-label">DevTools</span>
            </div>
            <button
              type="button"
              className="dock-btn"
              title={state.docked ? "Undock to center" : "Dock to right side"}
              onClick={() => dispatch({ type: "TOGGLE_DOCK" })}
              dangerouslySetInnerHTML={{ __html: state.docked ? ICONS.undock : ICONS.dock }}
            />
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
                placeholder="Type a command…"
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
              <div className="command-list" ref={commandListRef}>
                {filtered.length === 0 ? (
                  <div className="empty-state">
                    No commands match your search.
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
                  placeholder="e.g. make this button larger, fix the alignment…"
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

          {state.view === "performance" && state.performanceData && (
            <div>
              <div className="perf-back-row">
                <button
                  type="button"
                  className="perf-back-btn"
                  onClick={() => dispatch({ type: "SET_VIEW", view: "commands" })}
                >
                  <span dangerouslySetInnerHTML={{ __html: ICONS.back }} /> Back
                </button>
              </div>
              <div className="section-label">Performance Spotlight</div>
              <div className="perf-grid">
                <div className="perf-stat">
                  <strong>Total</strong>
                  {String(state.performanceData.totalRequests)}
                </div>
                <div className="perf-stat">
                  <strong>Errors</strong>
                  <span className={state.performanceData.errorCount > 0 ? "perf-error" : ""}>
                    {String(state.performanceData.errorCount)}
                  </span>
                </div>
                {state.performanceData.timing && (
                  <>
                    <div className="perf-stat">
                      <strong>Avg</strong>
                      {state.performanceData.timing.avg}ms
                    </div>
                    <div className="perf-stat">
                      <strong>p50</strong>
                      {state.performanceData.timing.p50}ms
                    </div>
                    <div className="perf-stat">
                      <strong>p95</strong>
                      <span className={state.performanceData.timing.p95 > 500 ? "perf-warn" : ""}>
                        {state.performanceData.timing.p95}ms
                      </span>
                    </div>
                    <div className="perf-stat">
                      <strong>Max</strong>
                      <span className={state.performanceData.timing.max > 1000 ? "perf-error" : ""}>
                        {state.performanceData.timing.max}ms
                      </span>
                    </div>
                  </>
                )}
              </div>
              {state.performanceData.slowRequests.length > 0 ? (
                <>
                  <div className="section-label" style={{ marginTop: 4 }}>
                    Slow Requests ({">"}
                    {state.performanceData.thresholdMs}ms)
                  </div>
                  <div className="perf-list">
                    {state.performanceData.slowRequests.map((req) => (
                      <div key={`${req.method}-${req.path}-${req.timestamp}`} className={`perf-row${req.isError ? " perf-row-error" : ""}`}>
                        <span className="perf-method">{req.method}</span>
                        <span className="perf-path">{summarizeText(req.path, 40)}</span>
                        <span className="perf-status">{req.statusCode}</span>
                        <span className={`perf-duration${req.durationMs > 1000 ? " perf-error" : " perf-warn"}`}>
                          {req.durationMs}ms
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  No requests slower than {state.performanceData.thresholdMs}ms
                </div>
              )}
            </div>
          )}

          {state.view === "health" && state.healthData && (
            <div>
              <div className="perf-back-row">
                <button
                  type="button"
                  className="perf-back-btn"
                  onClick={() => dispatch({ type: "SET_VIEW", view: "commands" })}
                >
                  <span dangerouslySetInnerHTML={{ __html: ICONS.back }} /> Back
                </button>
              </div>
              <div className="section-label">Plugin Health Dashboard</div>
              {state.healthData.length === 0 ? (
                <div className="empty-state">No request data recorded yet.</div>
              ) : (
                <div className="health-list">
                  {state.healthData.map((plugin) => (
                    <div key={plugin.pluginName} className="health-card">
                      <div className="health-header">
                        <span className="health-name">{plugin.pluginName}</span>
                        <span className={`health-badge${plugin.errorRate > 5 ? " health-badge-error" : plugin.errorRate > 0 ? " health-badge-warn" : ""}`}>
                          {plugin.errorRate}% errors
                        </span>
                      </div>
                      <div className="health-stats">
                        <span>{plugin.totalRequests} reqs</span>
                        <span>avg {plugin.avgDurationMs}ms</span>
                        <span>p95 {plugin.p95DurationMs}ms</span>
                        <span>max {plugin.maxDurationMs}ms</span>
                      </div>
                      {plugin.lastError && (
                        <div className="health-last-error">
                          Last error: {plugin.lastError.method} {plugin.lastError.path} → {plugin.lastError.statusCode}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {state.view === "waterfall" && (
            <div>
              <div className="perf-back-row">
                <button
                  type="button"
                  className="perf-back-btn"
                  onClick={() => dispatch({ type: "SET_VIEW", view: "commands" })}
                >
                  <span dangerouslySetInnerHTML={{ __html: ICONS.back }} /> Back
                </button>
              </div>
              <div className="section-label">Network Waterfall</div>
              {networkState.recentNetwork.length === 0 ? (
                <div className="empty-state">No network requests recorded yet.</div>
              ) : (
                <div className="wf-container">
                  {(() => {
                    const events = [...networkState.recentNetwork].reverse();
                    const times = events.map((e) => {
                      const end = new Date(e.timestamp).getTime();
                      const start = end - (e.durationMs || 0);
                      return { start, end };
                    });
                    const globalStart = Math.min(...times.map((t) => t.start));
                    const globalEnd = Math.max(...times.map((t) => t.end));
                    const range = globalEnd - globalStart || 1;
                    return events.map((evt, i) => {
                      const left = ((times[i].start - globalStart) / range) * 100;
                      const width = Math.max(((times[i].end - times[i].start) / range) * 100, 0.5);
                      const statusClass = !evt.status ? "wf-bar-error"
                        : evt.status >= 500 ? "wf-bar-error"
                        : evt.status >= 400 ? "wf-bar-warn"
                        : "";
                      return (
                        <div key={evt.id} className="wf-row">
                          <span className="wf-method">{evt.method}</span>
                          <span className="wf-path">{summarizeText(evt.path, 28)}</span>
                          <div className="wf-track">
                            <div
                              className={`wf-bar ${statusClass}`}
                              style={{ left: `${left}%`, width: `${width}%` }}
                            />
                          </div>
                          <span className="wf-duration">{evt.durationMs ?? "?"}ms</span>
                          <span className={`wf-status ${statusClass}`}>{evt.status ?? "ERR"}</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          )}

          {state.view === "streams" && state.streamsData && (
            <div>
              <div className="perf-back-row">
                <button
                  type="button"
                  className="perf-back-btn"
                  onClick={() => dispatch({ type: "SET_VIEW", view: "commands" })}
                >
                  <span dangerouslySetInnerHTML={{ __html: ICONS.back }} /> Back
                </button>
              </div>
              <div className="section-label">SSE Stream Debugger</div>
              <div className="perf-grid">
                <div className="perf-stat">
                  <strong>Active streams</strong>
                  {String(state.streamsData.totalActive)}
                </div>
              </div>
              {state.streamsData.streams.length === 0 ? (
                <div className="empty-state">No active SSE streams.</div>
              ) : (
                <div className="health-list">
                  {state.streamsData.streams.map((stream) => {
                    const streamKey = `${stream.pluginName}:${stream.streamId}`;
                    const isExpanded = expandedStream === streamKey;
                    return (
                      <div key={streamKey} className={`health-card${isExpanded ? " stream-expanded" : ""}`}>
                        <div
                          className="health-header stream-clickable"
                          onClick={() => toggleStreamExpand(stream.pluginName, stream.streamId)}
                        >
                          <span className="health-name">{stream.pluginName}</span>
                          <span className={`health-badge${stream.isCompleted ? " health-badge-warn" : ""}`}>
                            {stream.isCompleted ? "completed" : "active"}
                          </span>
                        </div>
                        <div className="stream-id">{stream.streamId}</div>
                        <div className="health-stats">
                          <span>{stream.clientCount} clients</span>
                          <span>{stream.eventCount} events</span>
                          <span>{stream.lastAccessAgo}</span>
                        </div>
                        {isExpanded && (
                          <div className="stream-events">
                            {streamEvents.length === 0 ? (
                              <div className="stream-event-empty">No buffered events</div>
                            ) : (
                              streamEvents.map((evt) => (
                                <div key={evt.id} className="stream-event">
                                  <div className="stream-event-header">
                                    <span className="stream-event-type">{evt.type}</span>
                                    <span className="stream-event-time">
                                      {new Date(evt.timestamp).toLocaleTimeString()}
                                    </span>
                                  </div>
                                  <div className="stream-event-data">
                                    {typeof evt.data === "string"
                                      ? evt.data
                                      : JSON.stringify(evt.data, null, 2)}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {state.view === "queries" && state.queriesData && (
            <div>
              <div className="perf-back-row">
                <button
                  type="button"
                  className="perf-back-btn"
                  onClick={() => dispatch({ type: "SET_VIEW", view: "commands" })}
                >
                  <span dangerouslySetInnerHTML={{ __html: ICONS.back }} /> Back
                </button>
              </div>
              <div className="section-label">Query Inspector</div>
              {state.queriesData.length === 0 ? (
                <div className="empty-state">No SQL queries recorded yet.</div>
              ) : (
                <div className="health-list">
                  {state.queriesData.map((q, i) => (
                    <div key={`${q.queryKey}-${q.timestamp}-${i}`} className="query-card">
                      <div className="query-header">
                        <span className="query-key">{q.queryKey}</span>
                        <div className="query-badges">
                          <span className={`health-badge${q.cacheHit ? "" : " health-badge-warn"}`}>
                            {q.cacheHit ? "cache hit" : "cache miss"}
                          </span>
                          {q.isObo && <span className="health-badge">OBO</span>}
                          {q.error && <span className="health-badge health-badge-error">error</span>}
                        </div>
                      </div>
                      <div className="health-stats">
                        <span>{q.durationMs}ms</span>
                        <span>{q.executorKey}</span>
                        <span>{new Date(q.timestamp).toLocaleTimeString()}</span>
                      </div>
                      {Object.keys(q.parameters).length > 0 && (
                        <div className="query-params">
                          {Object.entries(q.parameters).map(([k, v]) => {
                            const display = v && typeof v === "object" && "value" in (v as Record<string, unknown>)
                              ? String((v as Record<string, unknown>).value)
                              : String(v);
                            return <span key={k} className="query-param">{k}={display}</span>;
                          })}
                        </div>
                      )}
                      {q.error && (
                        <div className="health-last-error">{q.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {state.view === "console" && (
            <div>
              <div className="perf-back-row">
                <button
                  type="button"
                  className="perf-back-btn"
                  onClick={() => dispatch({ type: "SET_VIEW", view: "commands" })}
                >
                  <span dangerouslySetInnerHTML={{ __html: ICONS.back }} /> Back
                </button>
              </div>
              <div className="section-label">Console Output</div>
              {consoleState.recentEntries.length === 0 ? (
                <div className="empty-state">No console entries recorded.</div>
              ) : (
                <div className="console-list">
                  {consoleState.recentEntries.map((entry, i) => (
                    <div key={`${entry.timestamp}-${i}`} className={`console-entry console-${entry.level}`}>
                      <div className="console-entry-header">
                        <span className={`console-level console-level-${entry.level}`}>
                          {entry.level.toUpperCase()}
                        </span>
                        <span className="console-time">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="console-message">{entry.message}</div>
                      {entry.stack && (
                        <div className="console-stack">{entry.stack}</div>
                      )}
                    </div>
                  ))}
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
            <div
              className="summary-clickable"
              onClick={() => dispatch({ type: "SET_VIEW", view: "console" })}
            >
              <strong>Console entries</strong>
              {String(consoleState.recentEntries.length)}
              {consoleState.recentEntries.filter((e) => e.level === "error").length > 0 && (
                <span style={{ color: "#f87171", marginLeft: 4 }}>
                  ({consoleState.recentEntries.filter((e) => e.level === "error").length} errors)
                </span>
              )}
            </div>
            <div>
              <strong>Selected element</strong>
              {selectedElementLabel}
            </div>
          </div>
          {state.status && (
            <div className="status">
              {state.status.includes("…") && (
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
                placeholder="Prompt will appear here…"
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
              <kbd>{"\u2318"}</kbd><kbd>{"⇧"}</kbd><kbd>K</kbd> {state.docked ? "Undock" : "Dock"}
            </span>
            <span className="hint">
              <kbd>esc</kbd> Close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

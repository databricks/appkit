import { useEffect, useRef } from "react";
import type { AgentElementRegistry } from "./element-registry";
import type { ClientToolRegistry } from "./registry";
import { dispatchUiCall, synthesizeUiCatalog } from "./synthesize";

interface UseAgentToolChannelOptions {
  tools: ClientToolRegistry;
  elements: AgentElementRegistry;
  /** API base for the agents plugin routes, e.g. "/api/agents". */
  apiBase: string;
  /** Stable per-tab session id. */
  sessionId: string;
  /** When false, the channel is not opened (escape hatch). */
  enabled: boolean;
}

/**
 * Hold open a persistent SSE channel to the server and keep the server's copy
 * of this tab's tool catalog in sync. This is the unified path: the catalog is
 * registered once (and on every change) rather than sent per chat request, and
 * the server pushes `appkit.client_tool_call` events down the channel for BOTH
 * the in-app agent and external MCP clients. Incoming calls are dispatched
 * through the same registry and the outcome POSTed back.
 *
 * Runs only in the browser; a no-op during SSR.
 */
export function useAgentToolChannel({
  tools,
  elements,
  apiBase,
  sessionId,
  enabled,
}: UseAgentToolChannelOptions): void {
  // Keep the registries reachable from the long-lived EventSource handler
  // without re-subscribing the channel when they (stably) don't change.
  const refs = useRef({ tools, elements, apiBase, sessionId });
  refs.current = { tools, elements, apiBase, sessionId };

  // Push the current catalog to the server. Stored in a ref so both the
  // open-handler and the change-subscription call the same function.
  const registerRef = useRef<() => void>(() => {});
  registerRef.current = () => {
    const {
      tools: t,
      elements: el,
      apiBase: base,
      sessionId: sid,
    } = refs.current;
    const catalog = synthesizeUiCatalog(el, t.catalog());
    void fetch(`${base}/register-tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, tools: catalog }),
    }).catch(() => {
      // Best-effort: a failed registration is retried on the next change /
      // reconnect. Nothing the UI can do about it.
    });
  };

  // Re-register whenever the catalog shape changes (element mount/unmount,
  // raw-tool add/remove). Cheap: the registries notify synchronously.
  useEffect(() => {
    if (!enabled) return;
    const onChange = () => registerRef.current();
    const a = tools.subscribe(onChange);
    const b = elements.subscribe(onChange);
    return () => {
      a();
      b();
    };
  }, [enabled, tools, elements]);

  // Open the persistent channel and dispatch incoming tool calls.
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const url = `${apiBase}/tool-channel?sessionId=${encodeURIComponent(sessionId)}`;
    const source = new EventSource(url);

    source.onopen = () => registerRef.current();

    source.onmessage = async (event) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type !== "appkit.client_tool_call") return;
      const callId = msg.call_id as string;
      const toolName = msg.tool_name as string;
      const callArgs = (msg.args ?? {}) as Record<string, unknown>;

      const outcome = await dispatchUiCall(
        toolName,
        callArgs,
        refs.current.tools,
        refs.current.elements,
      );
      const body =
        outcome.kind === "ok"
          ? { callId, result: outcome.result }
          : { callId, error: outcome.error };
      void fetch(`${refs.current.apiBase}/client-tool-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    };

    return () => source.close();
  }, [enabled, apiBase, sessionId]);
}

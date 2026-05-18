import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  clearInspectorHistory,
  closeInspector,
  type StreamEventRecord,
  type StreamRecord,
  useStreamInspector,
} from "../hooks/use-stream-inspector";

type FilterMode =
  | "all"
  | "tool_calls"
  | "messages"
  | "approvals"
  | "sub_agents";

const FILTER_OPTIONS: Array<{ id: FilterMode; label: string }> = [
  { id: "all", label: "All" },
  { id: "tool_calls", label: "Tool calls" },
  { id: "messages", label: "Messages" },
  { id: "approvals", label: "Approvals" },
  { id: "sub_agents", label: "Sub-agents" },
];

function matchesFilter(
  event: StreamEventRecord["event"],
  mode: FilterMode,
): boolean {
  if (mode === "all") return true;
  if (mode === "messages") {
    return (
      event.type === "response.output_text.delta" ||
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done" ||
      event.type === "response.completed"
    );
  }
  if (mode === "tool_calls") {
    return (
      (event.type === "response.output_item.added" ||
        event.type === "response.output_item.done") &&
      event.item?.type === "function_call"
    );
  }
  if (mode === "approvals") {
    return event.type === "appkit.approval_pending";
  }
  if (mode === "sub_agents") {
    // Sub-agent invocations surface as `agent-<key>` function_calls; keep
    // `appkit.metadata` in here too since it carries threadId on new runs.
    if (event.item?.type === "function_call") {
      return event.item.name?.startsWith("agent-") ?? false;
    }
    return false;
  }
  return true;
}

function shortType(type: string): string {
  // Collapse the verbose `response.*` prefix for legibility.
  return type.replace(/^response\./, "").replace(/^appkit\./, "");
}

function formatTimestamp(relMs: number): string {
  if (relMs < 1000) return `${Math.round(relMs)}ms`;
  return `${(relMs / 1000).toFixed(2)}s`;
}

function EventRow({
  event,
  receivedAt,
  startedAt,
}: StreamEventRecord & { startedAt: number }) {
  const [expanded, setExpanded] = useState(false);
  const rel = receivedAt - startedAt;

  const isFunctionCall = event.item?.type === "function_call";
  const isApproval = event.type === "appkit.approval_pending";

  let summary: string;
  if (isApproval) {
    summary = `approval: ${event.tool_name}`;
  } else if (isFunctionCall) {
    summary = `${event.item?.name ?? "(unnamed)"}`;
  } else if (event.type === "response.output_text.delta") {
    summary = event.delta ?? "";
  } else {
    summary = "";
  }

  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-start gap-2 text-left hover:bg-muted/40 transition-colors"
      >
        {expanded ? (
          <ChevronDownIcon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-mono text-muted-foreground tabular-nums w-12 shrink-0">
              {formatTimestamp(rel)}
            </span>
            <span
              className={`text-xs font-mono shrink-0 ${
                isApproval
                  ? "text-red-600"
                  : isFunctionCall
                    ? "text-primary"
                    : "text-foreground"
              }`}
            >
              {shortType(event.type)}
            </span>
            {summary && (
              <span className="text-xs text-muted-foreground truncate">
                {summary}
              </span>
            )}
          </div>
          {expanded && (
            <pre className="mt-2 p-2 bg-muted/50 rounded text-[10px] font-mono text-foreground whitespace-pre-wrap break-all overflow-x-auto">
              {JSON.stringify(event, null, 2)}
            </pre>
          )}
        </div>
      </button>
    </div>
  );
}

function RunBlock({ record }: { record: StreamRecord }) {
  return (
    <div className="mb-4">
      <div className="px-3 py-2 bg-muted/60 border-y border-border text-xs">
        <div className="font-medium text-foreground truncate">
          {record.label}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {record.events.length} events · started{" "}
          {new Date(
            Date.now() - (performance.now() - record.startedAt),
          ).toLocaleTimeString()}
        </div>
      </div>
      <div>
        {record.events.map((er, idx) => (
          <EventRow
            key={`${record.id}-${idx}`}
            event={er.event}
            receivedAt={er.receivedAt}
            startedAt={record.startedAt}
          />
        ))}
      </div>
    </div>
  );
}

export function StreamInspector() {
  const { isOpen, records } = useStreamInspector();
  const [filter, setFilter] = useState<FilterMode>("all");

  const filteredRecords = useMemo(() => {
    if (filter === "all") return records;
    return records.map((r) => ({
      ...r,
      events: r.events.filter((er) => matchesFilter(er.event, filter)),
    }));
  }, [records, filter]);

  if (!isOpen) return null;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss handled globally via Esc */}
      <div
        onClick={closeInspector}
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40"
      />
      <aside className="fixed top-0 right-0 bottom-0 w-[420px] bg-card border-l border-border shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-200">
        <header className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Stream Inspector
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Agent SSE timeline · ⌘K to toggle · Esc to close
            </p>
          </div>
          <button
            type="button"
            onClick={closeInspector}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close inspector"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="px-3 py-2 border-b border-border flex items-center gap-1 flex-wrap shrink-0">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFilter(opt.id)}
              className={`text-[11px] px-2 py-1 rounded-full transition-colors ${
                filter === opt.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {opt.label}
            </button>
          ))}
          <div className="flex-1" />
          {records.length > 0 && (
            <button
              type="button"
              onClick={clearInspectorHistory}
              className="text-[11px] px-2 py-1 rounded-full text-muted-foreground hover:bg-muted transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredRecords.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No events yet. Ask the agent something to see the SSE stream here.
            </div>
          ) : (
            filteredRecords.map((r) => <RunBlock key={r.id} record={r} />)
          )}
        </div>
      </aside>
    </>
  );
}

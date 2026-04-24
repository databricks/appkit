import {
  FilterIcon,
  HighlighterIcon,
  Loader2Icon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { SSEEvent } from "../hooks/use-agent-stream";
import { useAgentStream } from "../hooks/use-agent-stream";

interface QuerySectionProps {
  onEvent?: (event: SSEEvent) => void;
}

const EXAMPLE_QUERIES = [
  "What's the busiest day of the week?",
  "Filter to only trips from February 2016",
  "Highlight Jan 10-15 on the chart",
  "Show trips over $50 and highlight the peak",
];

export function QuerySection({ onEvent }: QuerySectionProps) {
  const [input, setInput] = useState("");
  const [showTips, setShowTips] = useState(true);
  const { content, isLoading, send } = useAgentStream({
    agentName: "query",
    onEvent,
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || isLoading) return;
      const message = input.trim();
      setInput("");
      setShowTips(false);
      send(message);
    },
    [input, isLoading, send],
  );

  const handleExample = useCallback(
    (query: string) => {
      if (isLoading) return;
      setInput("");
      setShowTips(false);
      send(query);
    },
    [isLoading, send],
  );

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <SearchIcon className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            Ask about the data
          </h3>
          <span className="text-xs text-muted-foreground">
            — powered by the Query Agent
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowTips((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showTips ? "Hide tips" : "Show tips"}
        </button>
      </div>

      {showTips && (
        <div className="mb-4 rounded-lg border border-dashed border-border bg-muted/20 p-3">
          <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
            <SparklesIcon className="h-3.5 w-3.5" />
            This agent can control the dashboard directly
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            <div className="flex items-start gap-2">
              <FilterIcon className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Filter data
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Ask to filter by date range, zone, or fare amount and the
                  dashboard KPIs and charts will update live.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <HighlighterIcon className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Highlight periods
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Ask to highlight a date range and a shaded overlay will appear
                  on the Trips Over Time chart.
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => handleExample(q)}
                disabled={isLoading}
                className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Try "Filter to January 2016" or "Highlight the busiest week"'
          disabled={isLoading}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isLoading ? (
            <Loader2Icon className="h-4 w-4 animate-spin" />
          ) : (
            <SendIcon className="h-4 w-4" />
          )}
          Ask
        </button>
      </form>

      {(content || isLoading) && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 max-h-[300px] overflow-y-auto">
          {isLoading && !content && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2Icon className="h-4 w-4 animate-spin" />
              <span className="text-sm">Thinking...</span>
            </div>
          )}
          {content && (
            <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
              {content}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

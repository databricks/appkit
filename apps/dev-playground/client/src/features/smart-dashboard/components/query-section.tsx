import {
  FilterIcon,
  HighlighterIcon,
  Loader2Icon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useState } from "react";

interface QuerySectionProps {
  /** Dispatch a message through the chat pipeline. Owned by the route. */
  onSend: (message: string) => void;
  /** Streaming assistant text for the current run. */
  content: string;
  /** Whether a run is in flight. */
  isLoading: boolean;
}

const EXAMPLE_QUERIES = [
  "What's the busiest day of the week in 2016?",
  "Filter to November 2016 only",
  "Highlight the first week of Jan 2016 in red",
  "Focus on the fare distribution chart",
  "Clear all filters and highlights",
];

export function QuerySection({
  onSend,
  content,
  isLoading,
}: QuerySectionProps) {
  const [input, setInput] = useState("");
  const [showTips, setShowTips] = useState(true);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const message = input.trim();
      if (!message || isLoading) return;
      setInput("");
      setShowTips(false);
      onSend(message);
    },
    [input, isLoading, onSend],
  );

  const handleExample = useCallback(
    (query: string) => {
      if (isLoading) return;
      setInput("");
      setShowTips(false);
      onSend(query);
    },
    [isLoading, onSend],
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
            — query dispatcher routes to SQL analyst or dashboard pilot
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
            This agent can query data and control the dashboard
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            <div className="flex items-start gap-2">
              <FilterIcon className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Filter & highlight
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Ask to filter by date, ZIP, or fare, or highlight a period.
                  Dashboard updates live as the agent acts.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <HighlighterIcon className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Save view (approval gate)
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Ask to save the current view — it's destructive, so you'll see
                  an approval card before the agent can proceed.
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
          placeholder='Try "Filter to January 2016" or "Save this view as Peak Week"'
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

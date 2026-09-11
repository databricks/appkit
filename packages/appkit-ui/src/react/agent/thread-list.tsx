import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { useAgentThreads } from "../hooks/use-agent-threads";
import { cn } from "../lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";

export interface ThreadListProps {
  /** Currently open thread, highlighted in the list. */
  activeThreadId?: string | null;
  /** Fired when a thread row is clicked — wire it to your transcript view. */
  onSelect?: (threadId: string) => void;
  /** When provided, renders a "New" button that calls this. */
  onNewThread?: () => void;
  /**
   * Bump this to any new value to trigger a refetch — e.g. from
   * `<AgentThread onTurnComplete>` so the list reflects a new/updated thread.
   * The initial value never triggers a fetch (the list loads on mount anyway).
   */
  refetchSignal?: number;
  /** Base path the agents plugin is mounted under. Default `"/api/agents"`. */
  basePath?: string;
  /** Root container class. */
  className?: string;
}

/**
 * A conversation-history sidebar for agent apps. Owns {@link useAgentThreads}
 * (list + delete + rename); selection is controlled via `activeThreadId` +
 * `onSelect` so it pairs with {@link AgentThread}. Built on light primitives so
 * it drops into any layout.
 *
 * @example
 * ```tsx
 * const [active, setActive] = useState<string>();
 * <ThreadList activeThreadId={active} onSelect={setActive} onNewThread={() => setActive(undefined)} />
 * ```
 */
export function ThreadList({
  activeThreadId,
  onSelect,
  onNewThread,
  refetchSignal,
  basePath,
  className,
}: ThreadListProps) {
  const { threads, loading, error, refetch, deleteThread, renameThread } =
    useAgentThreads({ basePath });

  // Refetch when the parent bumps the signal (skips the initial value — the
  // hook already loads on mount).
  const initialSignal = useRef(refetchSignal);
  useEffect(() => {
    if (
      refetchSignal !== undefined &&
      refetchSignal !== initialSignal.current
    ) {
      void refetch();
    }
  }, [refetchSignal, refetch]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setDraft(current);
  };
  const commitRename = () => {
    const title = draft.trim();
    if (renamingId && title) void renameThread(renamingId, title);
    setRenamingId(null);
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      setRenamingId(null);
    }
  };

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold text-muted-foreground">
          Chats
        </span>
        {onNewThread && (
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={onNewThread}
          >
            + New
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {loading && threads.length === 0 && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {!loading && threads.length === 0 && !error && (
            <p className="py-8 text-center text-xs text-muted-foreground/60">
              No conversations yet
            </p>
          )}
          {error && (
            <p className="px-2 py-1 text-xs text-destructive">{error}</p>
          )}

          {threads.map((t) => {
            const isActive = t.id === activeThreadId;
            if (t.id === renamingId) {
              return (
                <input
                  key={t.id}
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- rename field appears on user action and should take focus
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={onRenameKey}
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              );
            }
            return (
              <div
                key={t.id}
                className={cn(
                  "group flex items-center gap-1 rounded-md",
                  isActive ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
                  onClick={() => onSelect?.(t.id)}
                >
                  <span className="block truncate text-sm">
                    {t.title || "New conversation"}
                  </span>
                  <span className="block text-[10px] text-muted-foreground/60">
                    {t.updatedAt.toLocaleString()} · {t.messageCount} msg
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Conversation actions"
                      className="px-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      ⋯
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => startRename(t.id, t.title)}
                    >
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => setPendingDelete(t.id)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the conversation and all of its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) void deleteThread(pendingDelete);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

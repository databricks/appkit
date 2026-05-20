import { useState } from "react";
import type { Thread } from "shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../../ui/sidebar";
import { DbIcon, OverflowIcon, TrashIcon } from "../db-icons";

type GroupedThreads = {
  today: Thread[];
  yesterday: Thread[];
  lastWeek: Thread[];
  lastMonth: Thread[];
  older: Thread[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function groupThreadsByDate(threads: Thread[]): GroupedThreads {
  const now = new Date();
  const yesterday = new Date(now.getTime() - MS_PER_DAY);
  const oneWeekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const oneMonthAgo = new Date(now);
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  return threads.reduce<GroupedThreads>(
    (groups, thread) => {
      // Use `updatedAt` so freshly-touched threads bubble back into "Today".
      const when = thread.updatedAt;

      if (isSameLocalDay(when, now)) {
        groups.today.push(thread);
      } else if (isSameLocalDay(when, yesterday)) {
        groups.yesterday.push(thread);
      } else if (when > oneWeekAgo) {
        groups.lastWeek.push(thread);
      } else if (when > oneMonthAgo) {
        groups.lastMonth.push(thread);
      } else {
        groups.older.push(thread);
      }

      return groups;
    },
    { today: [], yesterday: [], lastWeek: [], lastMonth: [], older: [] },
  );
}

function deriveThreadLabel(thread: Thread): string {
  const firstUser = thread.messages.find((m) => m.role === "user");
  const text = firstUser?.content?.trim();
  if (!text) return "(new chat)";
  // Match the original sidebar's clipping; the menu button truncates with
  // CSS anyway, but a hard cap protects against pathological one-line
  // pasted prompts that could blow up the DOM.
  if (text.length > 80) return `${text.slice(0, 80)}…`;
  return text;
}

const GROUP_DEFINITIONS = [
  { key: "today" as const, label: "Today" },
  { key: "yesterday" as const, label: "Yesterday" },
  { key: "lastWeek" as const, label: "Last 7 days" },
  { key: "lastMonth" as const, label: "Last 30 days" },
  { key: "older" as const, label: "Older than last month" },
];

interface ChatHistorySidebarProps {
  threads: Thread[] | null;
  loading: boolean;
  error: Error | null;
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void> | void;
}

/**
 * Date-grouped thread list with per-item delete (confirmation via
 * AlertDialog). Mirrors the structure of the original
 * `sidebar-history.tsx` from the e2e-chatbot template, minus the
 * Share/visibility submenu and infinite-scroll pagination (out of scope —
 * `Thread` has no `visibility` field and `useThreadList` returns the full
 * list in a single fetch).
 *
 * Presentational only — owned state lives in the parent so list refreshes
 * driven by `onFinish` and delete navigation stay coordinated.
 */
export function ChatHistorySidebar({
  threads,
  loading,
  error,
  activeThreadId,
  onSelect,
  onDelete,
}: ChatHistorySidebarProps) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  if (loading && !threads) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Today</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex flex-col gap-1">
            {[44, 32, 28, 64, 52].map((w) => (
              <div
                key={w}
                className="flex h-8 items-center gap-2 rounded-md px-2"
              >
                <div
                  className="bg-sidebar-accent-foreground/10 h-4 max-w-(--skeleton-width) flex-1 rounded-md"
                  style={
                    {
                      "--skeleton-width": `${w}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
            ))}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  if (error) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <div className="text-destructive px-2 py-1 text-xs">
            {error.message}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  if (!threads || threads.length === 0) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <div className="text-muted-foreground flex w-full flex-row items-center justify-center gap-2 px-2 text-sm">
            Your conversations will appear here once you start chatting!
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  const grouped = groupThreadsByDate(threads);

  return (
    <>
      {GROUP_DEFINITIONS.map(({ key, label }) => {
        const items = grouped[key];
        if (items.length === 0) return null;
        return (
          <SidebarGroup key={key}>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((thread) => (
                  <SidebarMenuItem key={thread.id}>
                    <SidebarMenuButton
                      isActive={thread.id === activeThreadId}
                      onClick={() => onSelect(thread.id)}
                      title={deriveThreadLabel(thread)}
                      className="cursor-pointer"
                    >
                      <span className="truncate">
                        {deriveThreadLabel(thread)}
                      </span>
                    </SidebarMenuButton>

                    <DropdownMenu modal>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction
                          showOnHover={thread.id !== activeThreadId}
                          aria-label="Open thread actions"
                          className="cursor-pointer"
                        >
                          <DbIcon icon={OverflowIcon} size={16} />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        side="bottom"
                        align="end"
                        className="rounded-lg"
                      >
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setPendingDeleteId(thread.id)}
                          className="cursor-pointer"
                        >
                          <DbIcon icon={TrashIcon} size={16} />
                          <span>Delete</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this
              chat thread and its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!pendingDeleteId) return;
                const id = pendingDeleteId;
                setPendingDeleteId(null);
                await onDelete(id);
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

import { ServerIcon, ShieldAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  ShieldCheckIcon,
  ShieldOffIcon as ShieldXIcon,
  WrenchIcon,
  XCircleIcon,
} from "../db-icons";

export type ChatToolCallState =
  /** Tool input received, waiting for output. */
  | "pending"
  /** Tool produced output. */
  | "completed"
  /** Tool produced an error. */
  | "error"
  /** Approval gate waiting on user decision. */
  | "approval-pending"
  /** Approval decision in flight. */
  | "approving"
  /** User approved the tool call. */
  | "approved"
  /** User denied the tool call. */
  | "denied";

export interface ChatToolCallProps {
  toolName: string;
  /** Tool call input — rendered as JSON in the parameters block. */
  input: unknown;
  /** Tool output (regular tool calls). Stringified if not already a string. */
  output?: unknown;
  /** Server-reported error for this tool call. */
  errorText?: string;
  state: ChatToolCallState;
  /** Render as an approval gate (banner + Allow/Deny footer). */
  isApproval?: boolean;
  /** Optional MCP server name shown in the approval banner. */
  serverName?: string;
  /** Approval-variant callbacks. Required when `isApproval` is true. */
  onApprove?: () => void;
  onDeny?: () => void;
  className?: string;
}

function StatusBadge({ state }: { state: ChatToolCallState }) {
  // Tones map to chat-theme `--badge-*` token pairs so host apps can
  // rebrand by re-assigning `--primary`/`--success`/`--warning`/
  // `--destructive` (see `chat-theme.css`).
  const config: Record<
    ChatToolCallState,
    { label: string; icon: ReactNode; className: string }
  > = {
    pending: {
      label: "Running",
      icon: <ClockIcon className="size-3 animate-pulse" />,
      className: "bg-[var(--badge-info-bg)] text-[var(--badge-info-fg)]",
    },
    completed: {
      label: "Completed",
      icon: <CheckCircleIcon className="size-3" />,
      className: "bg-[var(--badge-success-bg)] text-[var(--badge-success-fg)]",
    },
    error: {
      label: "Error",
      icon: <XCircleIcon className="size-3" />,
      className: "bg-[var(--badge-error-bg)] text-[var(--badge-error-fg)]",
    },
    "approval-pending": {
      label: "Pending",
      icon: <ShieldAlertIcon className="size-3" />,
      className: "bg-[var(--badge-warning-bg)] text-[var(--badge-warning-fg)]",
    },
    approving: {
      label: "Submitting",
      icon: <ClockIcon className="size-3 animate-pulse" />,
      className: "bg-[var(--badge-warning-bg)] text-[var(--badge-warning-fg)]",
    },
    approved: {
      label: "Allowed",
      icon: <ShieldCheckIcon className="size-3" />,
      className: "bg-[var(--badge-success-bg)] text-[var(--badge-success-fg)]",
    },
    denied: {
      label: "Denied",
      icon: <ShieldXIcon className="size-3" />,
      className: "bg-[var(--badge-error-bg)] text-[var(--badge-error-fg)]",
    },
  };
  const c = config[state];
  return (
    <Badge
      variant="secondary"
      className={cn(
        "flex items-center gap-1 rounded-full border-0 font-medium text-xs",
        c.className,
      )}
    >
      {c.icon}
      <span>{c.label}</span>
    </Badge>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return formatJson(value);
}

/**
 * Collapsible tool-call card. Renders both regular tool invocations and
 * approval gates with a shared layout — only the banner and footer differ.
 */
export function ChatToolCall({
  toolName,
  input,
  output,
  errorText,
  state,
  isApproval = false,
  serverName,
  onApprove,
  onDeny,
  className,
}: ChatToolCallProps) {
  // Initial-only: collapsed iff the call already finished successfully.
  // Pending/error/approval calls open by default; once the user toggles
  // the card, their choice sticks regardless of subsequent state changes.
  const [isOpen, setIsOpen] = useState(state !== "completed");
  const showOutput =
    !isApproval && (state === "completed" || state === "error");
  const showApprovalActions = isApproval && state === "approval-pending";

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "not-prose w-full overflow-hidden rounded-xl border bg-card/60",
        isApproval && "bg-muted/30",
        className,
      )}
    >
      {isApproval && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-xs">
          <ServerIcon className="size-3 text-muted-foreground" />
          <span className="font-medium text-muted-foreground">
            Tool Call Request
          </span>
          {serverName && (
            <>
              <span className="text-muted-foreground/50">•</span>
              <span className="truncate text-muted-foreground">
                {serverName}
              </span>
            </>
          )}
          <span className="ml-auto">
            <StatusBadge state={state} />
          </span>
        </div>
      )}

      <CollapsibleTrigger className="group/tool flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "truncate text-sm",
              isApproval ? "font-mono" : "font-medium",
            )}
          >
            {toolName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isApproval && <StatusBadge state={state} />}
          <ChevronDownIcon
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              isOpen ? "rotate-180" : "rotate-0",
            )}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        )}
      >
        <div className="space-y-1.5 px-3 pb-3">
          <h4 className="font-medium text-muted-foreground text-[10px] uppercase tracking-wide">
            Parameters
          </h4>
          <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/60 p-2.5 text-xs font-mono">
            {formatJson(input)}
          </pre>
        </div>

        {showOutput && (
          <div className="space-y-1.5 px-3 pb-3">
            <h4 className="font-medium text-muted-foreground text-[10px] uppercase tracking-wide">
              {errorText ? "Error" : "Result"}
            </h4>
            <pre
              className={cn(
                "overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md p-2.5 text-xs font-mono",
                errorText
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted/60",
              )}
            >
              {errorText ?? formatOutput(output)}
            </pre>
          </div>
        )}

        {showApprovalActions && (
          <div className="flex flex-col gap-3 border-t border-amber-300 bg-amber-50/50 p-3 dark:border-amber-700 dark:bg-amber-950/20">
            <div className="flex items-start gap-2">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-amber-800 text-sm dark:text-amber-200">
                This tool requires your permission to run.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={onApprove}
                className="bg-green-600 text-white hover:bg-green-700"
              >
                <ShieldCheckIcon className="mr-1.5 size-4" />
                Allow
              </Button>
              <Button size="sm" variant="outline" onClick={onDeny}>
                <ShieldXIcon className="mr-1.5 size-4" />
                Deny
              </Button>
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

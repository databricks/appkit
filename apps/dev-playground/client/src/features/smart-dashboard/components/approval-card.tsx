import { ShieldAlertIcon } from "lucide-react";
import type { Highlight } from "../hooks/use-action-dispatcher";
import type { DashboardFilters } from "../hooks/use-dashboard-data";

export interface PendingApproval {
  approvalId: string;
  streamId: string;
  toolName: string;
  args: unknown;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  };
}

interface ApprovalCardProps {
  approval: PendingApproval;
  filters: DashboardFilters;
  highlights: Highlight[];
  onDecide: (approvalId: string, decision: "approve" | "deny") => void;
}

function formatFilters(filters: DashboardFilters): string {
  const entries = Object.entries(filters).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function formatHighlights(highlights: Highlight[]): string {
  if (highlights.length === 0) return "(none)";
  return highlights
    .map(
      (h) =>
        `${h.start}..${h.end}${h.label ? ` (${h.label})` : ""} [${h.color}]`,
    )
    .join("; ");
}

export function ApprovalCard({
  approval,
  filters,
  highlights,
  onDecide,
}: ApprovalCardProps) {
  const args =
    typeof approval.args === "object" && approval.args !== null
      ? (approval.args as Record<string, unknown>)
      : {};
  const isDestructive = approval.annotations?.destructive === true;

  return (
    <div className="rounded-xl border border-red-500/40 bg-red-500/[0.06] p-4 shadow-sm">
      <div className="flex items-start gap-2 mb-3">
        <ShieldAlertIcon className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-sm text-foreground">
              Approval required
            </h3>
            {isDestructive && (
              <span className="text-[10px] uppercase tracking-wide bg-red-500/20 text-red-600 px-2 py-0.5 rounded-full font-medium">
                destructive
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            The agent wants to call{" "}
            <code className="font-mono text-foreground">
              {approval.toolName}
            </code>
            . Review the arguments before approving.
          </p>
        </div>
      </div>

      {Object.keys(args).length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-foreground mb-1.5">
            Arguments
          </div>
          <table className="w-full text-xs">
            <tbody>
              {Object.entries(args).map(([key, value]) => (
                <tr
                  key={key}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground w-[30%] align-top">
                    {key}
                  </td>
                  <td className="py-1.5 text-foreground break-words">
                    {typeof value === "string"
                      ? value
                      : JSON.stringify(value, null, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-3 space-y-1 text-xs">
        <div className="text-foreground font-medium">
          Current dashboard state
        </div>
        <div className="text-muted-foreground">
          <span className="font-mono">filters</span>: {formatFilters(filters)}
        </div>
        <div className="text-muted-foreground">
          <span className="font-mono">highlights</span>:{" "}
          {formatHighlights(highlights)}
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={() => onDecide(approval.approvalId, "deny")}
          className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted transition-colors"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onDecide(approval.approvalId, "approve")}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors font-medium"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

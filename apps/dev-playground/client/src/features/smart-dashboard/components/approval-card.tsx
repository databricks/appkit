import { CheckCircle2Icon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useState } from "react";
import type { Highlight } from "../hooks/use-action-dispatcher";
import type { DashboardFilters } from "../hooks/use-dashboard-data";
import { captureDashboardAsDataUrl } from "../lib/capture-dashboard";

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
  /** Root element to capture when the approved tool is `save_view`. */
  dashboardRef: React.RefObject<HTMLElement | null>;
  onDecide: (approvalId: string, decision: "approve" | "deny") => void;
  /** Notification surfaced back to the route for the toast. */
  onSaved?: (info: { name: string; volumePath: string }) => void;
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
  dashboardRef,
  onDecide,
  onSaved,
}: ApprovalCardProps) {
  const args =
    typeof approval.args === "object" && approval.args !== null
      ? (approval.args as Record<string, unknown>)
      : {};
  const isDestructive = approval.annotations?.destructive === true;
  const isSaveView = approval.toolName === "save_view";

  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "capturing" }
    | { kind: "uploading"; previewUrl: string }
    | { kind: "done"; volumePath: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const handleApprove = useCallback(async () => {
    if (!isSaveView) {
      onDecide(approval.approvalId, "approve");
      return;
    }

    const root = dashboardRef.current;
    if (!root) {
      setPhase({
        kind: "error",
        message:
          "Cannot locate the dashboard element to capture. Contact support.",
      });
      return;
    }

    try {
      setPhase({ kind: "capturing" });
      // Conservative capture settings: AppKit's server plugin caps
      // JSON bodies at 100kb by default. JPEG @ quality 0.75 + scale
      // 0.6 keeps base64 payloads in the 25-60kb range for typical
      // dashboard viewports with room for metadata.
      const { dataUrl } = await captureDashboardAsDataUrl(root, {
        quality: 0.75,
        scale: 0.6,
      });
      setPhase({ kind: "uploading", previewUrl: dataUrl });

      const name =
        typeof args.name === "string" && args.name.trim() !== ""
          ? (args.name as string)
          : "Untitled view";
      const description =
        typeof args.description === "string" ? args.description : undefined;

      const uploadRes = await fetch("/api/dashboard/save-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          filters,
          highlights,
          pngBase64: dataUrl,
        }),
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(`Upload failed (${uploadRes.status}): ${err}`);
      }

      const uploadJson = (await uploadRes.json()) as {
        volumePath: string;
      };

      setPhase({ kind: "done", volumePath: uploadJson.volumePath });
      onSaved?.({ name, volumePath: uploadJson.volumePath });
      onDecide(approval.approvalId, "approve");
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [
    isSaveView,
    args,
    filters,
    highlights,
    dashboardRef,
    onDecide,
    onSaved,
    approval.approvalId,
  ]);

  const busy = phase.kind === "capturing" || phase.kind === "uploading";

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
            {isSaveView
              ? ". Approving captures the current dashboard and uploads it as a saved view."
              : ". Review the arguments before approving."}
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

      {phase.kind === "uploading" && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-2">
          <div className="text-[11px] text-muted-foreground mb-1.5 font-medium">
            Captured preview (uploading…)
          </div>
          <img
            src={phase.previewUrl}
            alt="Dashboard preview"
            className="max-h-40 w-full object-contain rounded border border-border bg-background"
          />
        </div>
      )}

      {phase.kind === "done" && (
        <div className="mb-3 rounded-md border border-green-500/40 bg-green-500/10 p-2 flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0" />
          <span>
            Saved to <code className="font-mono">{phase.volumePath}</code>
          </span>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-400">
          {phase.message}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={() => onDecide(approval.approvalId, "deny")}
          disabled={busy}
          className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted transition-colors disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={handleApprove}
          disabled={busy || phase.kind === "done"}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors font-medium disabled:opacity-50"
        >
          {phase.kind === "capturing"
            ? "Capturing…"
            : phase.kind === "uploading"
              ? "Uploading…"
              : phase.kind === "done"
                ? "Approved"
                : isSaveView
                  ? "Approve & save"
                  : "Approve"}
        </button>
      </div>
    </div>
  );
}

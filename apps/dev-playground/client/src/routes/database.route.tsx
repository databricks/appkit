import { DatabaseHTTPError, db } from "@databricks/appkit-ui/js";
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

/**
 * Database plugin demo: `db.cases` is typed from `config/database/schema.ts`;
 * the Vite-generated `database.d.ts` keeps this route honest at compile time.
 */

const STATUS_VALUES = [
  "New",
  "In Review",
  "Pending",
  "Closed",
  "Escalated",
] as const;

const STATUS_FILTER_ALL = "__all__";

const RISK_BADGE: Record<string, "default" | "secondary" | "destructive"> = {
  High: "destructive",
  Medium: "secondary",
  Low: "default",
};

export const Route = createFileRoute("/database")({
  component: DatabaseRoute,
});

function DatabaseRoute() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Database Plugin Demo</h1>
          <p className="text-base text-muted-foreground">
            Full CRUD flow against <code>cases</code> via the typed{" "}
            <code>db</code> client. Every action hits an auto-generated route at{" "}
            <code>/api/database/cases</code>.
          </p>
        </div>

        <div className="grid lg:grid-cols-[2fr_1fr] gap-6">
          <CaseList />
          <CreateCase />
        </div>
      </div>
    </div>
  );
}

function useCases(status: string) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof db.cases.toArray>
  > | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const base =
          status === STATUS_FILTER_ALL ? db.cases : db.cases.where({ status });
        const [rows, count] = await Promise.all([
          base.order({ created_at: "desc" }).limit(50).toArray(ctrl.signal),
          base.count(ctrl.signal),
        ]);
        if (!active) return;
        setData(rows);
        setTotal(count);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (!active) return;
        setError(describeError(err));
      } finally {
        if (active) setLoading(false);
      }
    };

    run();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [status]);

  return { data, total, loading, error, refetch };
}

function CaseList() {
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_FILTER_ALL);
  const { data, total, loading, error, refetch } = useCases(statusFilter);
  const statusFilterId = useId();

  const filterLabel = useMemo(
    () =>
      statusFilter === STATUS_FILTER_ALL
        ? "all statuses"
        : `status = "${statusFilter}"`,
    [statusFilter],
  );

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold">Cases</h2>
          <p className="text-sm text-muted-foreground">
            {total === null ? "—" : total} row{total === 1 ? "" : "s"} (
            {filterLabel})
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={statusFilterId} className="text-sm">
            Status
          </Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id={statusFilterId} className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={STATUS_FILTER_ALL}>All</SelectItem>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={refetch}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assigned to</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === null && loading && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  Loading cases…
                </TableCell>
              </TableRow>
            )}
            {data !== null && data.length === 0 && !loading && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  No cases match the current filter.
                </TableCell>
              </TableRow>
            )}
            {data?.map((row) => (
              <CaseRowItem key={row.case_id} row={row} onChanged={refetch} />
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function CaseRowItem({
  row,
  onChanged,
}: {
  row: Awaited<ReturnType<typeof db.cases.toArray>>[number];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateStatus = async (next: string) => {
    if (next === row.status) return;
    setBusy(true);
    setError(null);
    try {
      await db.cases.update(row.case_id, {
        status: next,
        updated_at: new Date().toISOString(),
      });
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete case ${row.case_id}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await db.cases.delete(row.case_id);
      onChanged();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <TableRow data-busy={busy} className="align-top">
      <TableCell className="font-mono text-xs">
        <div className="font-semibold">{row.case_id}</div>
        <div className="text-muted-foreground">{row.case_type ?? "—"}</div>
      </TableCell>
      <TableCell>
        <div className="font-medium">{row.entity_name ?? row.entity_id}</div>
        <div className="text-xs text-muted-foreground">{row.entity_id}</div>
      </TableCell>
      <TableCell>
        {row.risk_level ? (
          <Badge variant={RISK_BADGE[row.risk_level] ?? "default"}>
            {row.risk_level} {row.risk_score != null && `(${row.risk_score})`}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <Select value={row.status} onValueChange={updateStatus} disabled={busy}>
          <SelectTrigger className="w-[130px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_VALUES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && <div className="text-xs text-destructive mt-1">{error}</div>}
      </TableCell>
      <TableCell className="text-sm">{row.assigned_to ?? "—"}</TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          onClick={remove}
          disabled={busy}
          className="text-destructive hover:text-destructive"
        >
          Delete
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CreateCase() {
  const [caseId, setCaseId] = useState("");
  const [entityId, setEntityId] = useState("");
  const [entityName, setEntityName] = useState("");
  const [riskLevel, setRiskLevel] = useState("Medium");
  const [status, setStatus] = useState("New");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  const caseIdField = useId();
  const entityIdField = useId();
  const entityNameField = useId();
  const riskField = useId();
  const statusField = useId();

  const disabled = busy || caseId.trim() === "" || entityId.trim() === "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setBusy(true);
    setMessage(null);
    try {
      await db.cases.create({
        case_id: caseId.trim(),
        entity_id: entityId.trim(),
        entity_name: entityName.trim() || null,
        risk_level: riskLevel,
        status,
      });
      setMessage({ kind: "ok", text: `Created ${caseId.trim()}` });
      setCaseId("");
      setEntityId("");
      setEntityName("");
    } catch (err) {
      setMessage({ kind: "err", text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6 h-fit">
      <h2 className="text-xl font-semibold mb-1">New Case</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Exercises <code>db.cases.create(...)</code>. The server validates the
        body against the Zod schema generated from <code>schema.ts</code>.
      </p>

      <form className="space-y-3" onSubmit={submit}>
        <div>
          <Label htmlFor={caseIdField}>Case ID</Label>
          <Input
            id={caseIdField}
            placeholder="CASE-1001"
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        <div>
          <Label htmlFor={entityIdField}>Entity ID</Label>
          <Input
            id={entityIdField}
            placeholder="ENT-5001"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            disabled={busy}
            required
          />
        </div>
        <div>
          <Label htmlFor={entityNameField}>Entity Name</Label>
          <Input
            id={entityNameField}
            placeholder="Acme Trading"
            value={entityName}
            onChange={(e) => setEntityName(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <Label htmlFor={riskField}>Risk Level</Label>
          <Select value={riskLevel} onValueChange={setRiskLevel}>
            <SelectTrigger id={riskField}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="High">High</SelectItem>
              <SelectItem value="Medium">Medium</SelectItem>
              <SelectItem value="Low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor={statusField}>Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id={statusField}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button type="submit" disabled={disabled} className="w-full">
          {busy ? "Creating…" : "Create case"}
        </Button>

        {message && (
          <div
            className={
              message.kind === "ok"
                ? "text-sm text-green-600 dark:text-green-400"
                : "text-sm text-destructive"
            }
          >
            {message.text}
          </div>
        )}
      </form>
    </Card>
  );
}

function describeError(err: unknown): string {
  if (err instanceof DatabaseHTTPError) {
    const body = err.body as { error?: string; message?: string } | undefined;
    return `HTTP ${err.statusCode} — ${body?.error ?? body?.message ?? err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

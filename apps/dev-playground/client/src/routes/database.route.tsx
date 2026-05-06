import { DatabaseHTTPError, db } from "@databricks/appkit-ui/js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CreateEntity,
  EditEntity,
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
  ViewEntity,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { codeToHtml } from "shiki";

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

const CASE_VIEW_FIELDS = [
  "case_id",
  "entity_name",
  "risk_level",
  "status",
  "assigned_to",
] as const;

const CASE_MUTATION_FIELDS = [
  "case_id",
  "entity_id",
  "entity_name",
  "risk_level",
  "status",
] as const;

const MANUAL_DB_SNIPPET = `const base =
  status === "All" ? db.cases : db.cases.where({ status });

const [rows, count] = await Promise.all([
  base.order({ created_at: "desc" }).limit(50).toArray(),
  base.count(),
]);

await db.cases.create({
  case_id: "CASE-1001",
  entity_id: "ENT-5001",
  entity_name: "Acme Trading",
  risk_level: "Medium",
  status: "New",
});

await db.cases.update("CASE-1001", {
  status: "Closed",
  updated_at: new Date().toISOString(),
});

await db.cases.delete("CASE-1001");`;

const ENTITY_COMPONENTS_SNIPPET = `const [createOpen, setCreateOpen] = useState(false);
const [editingId, setEditingId] = useState<string | null>(null);

<ViewEntity
  entity="cases"
  fields={["case_id", "entity_name", "risk_level", "status", "assigned_to"]}
  order={{ created_at: "desc" }}
  limit={8}
  onRowClick={(row) => setEditingId(row.case_id)}
/>

<CreateEntity
  entity="cases"
  fields={["case_id", "entity_id", "entity_name", "risk_level", "status"]}
  open={createOpen}
  onOpenChange={setCreateOpen}
/>

{editingId && (
  <EditEntity
    entity="cases"
    id={editingId}
    fields={["entity_id", "entity_name", "risk_level", "status"]}
    open
    onOpenChange={(open) => !open && setEditingId(null)}
  />
)}`;

export const Route = createFileRoute("/database")({
  component: DatabaseRoute,
});

function DatabaseRoute() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-10">
        <div className="mb-8 max-w-3xl">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Database plugin beta
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-3">
            Two ways to build on the same typed entity API
          </h1>
          <p className="text-base text-muted-foreground">
            Both sections hit the auto-mounted <code>/api/database/cases</code>{" "}
            routes. The left side shows hand-built product UI using{" "}
            <code>db.cases</code>; the right side shows the schema-driven entity
            components that generate the table and forms from metadata.
          </p>
        </div>

        <div className="grid xl:grid-cols-2 gap-6 items-start">
          <ManualDbSection />
          <EntityComponentsSection />
        </div>
      </div>
    </div>
  );
}

function CodeBlock({
  code,
  lang = "typescript",
}: {
  code: string;
  lang?: string;
}) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let active = true;
    codeToHtml(code, {
      lang,
      theme: "dark-plus",
    }).then((highlighted) => {
      if (active) setHtml(highlighted);
    });
    return () => {
      active = false;
    };
  }, [code, lang]);

  return (
    <div
      className="rounded-md overflow-hidden border bg-zinc-950 [&>pre]:m-0 [&>pre]:max-h-[420px] [&>pre]:overflow-auto [&>pre]:p-4 [&>pre]:text-xs [&>pre]:leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CodeDisclosure({
  code,
  label = "Show snippet",
}: {
  code: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide snippet" : label}
      </Button>
      {open && <CodeBlock code={code} />}
    </div>
  );
}

function ManualDbSection() {
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Side A
        </div>
        <CardTitle>Hand-built UI, typed database client</CardTitle>
        <CardDescription>
          Custom AML case workflow using direct, typed calls like{" "}
          <code>db.cases.where(...)</code>, <code>create</code>,{" "}
          <code>update</code>, and <code>delete</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <CodeDisclosure code={MANUAL_DB_SNIPPET} />
        <CaseList refreshToken={refreshToken} />
        <CreateCase onCreated={refresh} />
      </CardContent>
    </Card>
  );
}

function EntityComponentsSection() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Side B
        </div>
        <CardTitle>Entity components from the same schema</CardTitle>
        <CardDescription>
          Generic table and mutation dialogs driven by column metadata from{" "}
          <code>config/database/schema.ts</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <CodeDisclosure code={ENTITY_COMPONENTS_SNIPPET} />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
          <div>
            <div className="font-medium">Cases entity</div>
            <div className="text-sm text-muted-foreground">
              Click a row to open the generated edit dialog.
            </div>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            New with component
          </Button>
        </div>
        <ViewEntity
          key={refreshToken}
          entity="cases"
          fields={CASE_VIEW_FIELDS}
          order={{ created_at: "desc" }}
          limit={8}
          onRowClick={(row) => setEditingId(row.case_id)}
        />
        <CreateEntity
          entity="cases"
          fields={CASE_MUTATION_FIELDS}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSuccess={refresh}
          title="Create case with Entity component"
          description="The form is generated from database.columns.ts metadata."
        />
        {editingId && (
          <EditEntity
            entity="cases"
            id={editingId}
            fields={["entity_id", "entity_name", "risk_level", "status"]}
            open
            onOpenChange={(open) => {
              if (!open) setEditingId(null);
            }}
            onSuccess={refresh}
            title={`Edit ${editingId}`}
            description="Only editable, non-generated columns are shown."
          />
        )}
      </CardContent>
    </Card>
  );
}

function useCases(status: string, refreshToken: number) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof db.cases.toArray>
  > | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    void refreshToken;
    void tick;
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
  }, [status, refreshToken, tick]);

  return { data, total, loading, error, refetch };
}

function CaseList({ refreshToken }: { refreshToken: number }) {
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_FILTER_ALL);
  const { data, total, loading, error, refetch } = useCases(
    statusFilter,
    refreshToken,
  );
  const statusFilterId = useId();

  const filterLabel = useMemo(
    () =>
      statusFilter === STATUS_FILTER_ALL
        ? "all statuses"
        : `status = "${statusFilter}"`,
    [statusFilter],
  );

  return (
    <div>
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
    </div>
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

function CreateCase({ onCreated }: { onCreated: () => void }) {
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

  const submit = async (e: FormEvent) => {
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
      onCreated();
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

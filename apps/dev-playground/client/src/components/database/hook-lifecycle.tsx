import { Badge } from "@databricks/appkit-ui/react";

/**
 * The create transaction and the separate read serializer. Only database
 * writes through the transaction-bound client share the mutation's rollback.
 */

interface Step {
  name: string;
  kind: "async" | "sql" | "sync";
  detail: string;
}

const IN_TRANSACTION: Step[] = [
  {
    name: "beforeCreate(values, ctx)",
    kind: "async",
    detail:
      "Calls the redaction agent with a 10-second cancellation signal, rejects failed or blank output, and stamps the private author_email.",
  },
  {
    name: "INSERT",
    kind: "sql",
    detail: "The row the caller asked for, plus whatever the hook added.",
  },
  {
    name: "afterCreate(row, ctx)",
    kind: "async",
    detail:
      "Sees the persisted row. Writes through ctx.app.database join this transaction — here, the note_events entry.",
  },
];

const KIND_LABEL: Record<Step["kind"], string> = {
  async: "async",
  sql: "sql",
  sync: "sync",
};

function StepRow({ step }: { step: Step }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <Badge
        variant={step.kind === "sql" ? "secondary" : "outline"}
        className="shrink-0 w-14 justify-center text-[10px]"
      >
        {KIND_LABEL[step.kind]}
      </Badge>
      <div className="min-w-0">
        <code className="text-xs font-semibold">{step.name}</code>
        <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
      </div>
    </div>
  );
}

export function HookLifecycle() {
  return (
    <div className="space-y-3">
      <code className="text-xs font-semibold">POST /api/database/notes</code>

      <div className="rounded-md border-2 border-dashed p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            one transaction
          </span>
          <span className="text-xs text-muted-foreground">
            a throw anywhere rolls back everything below
          </span>
        </div>
        <div className="divide-y">
          {IN_TRANSACTION.map((step) => (
            <StepRow key={step.name} step={step} />
          ))}
        </div>
      </div>

      <div className="rounded-md border p-3">
        <div className="mb-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            on a subsequent read
          </span>
        </div>
        <StepRow
          step={{
            name: "serialize(row, { operation })",
            kind: "sync",
            detail:
              "Runs on the projected public row. Its type returns a value, not a promise, so the read path cannot grow a network call — anything derived has to already be on the row.",
          }}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        <code>ctx.app.database</code> provides the transaction-bound database
        client. Import other APIs separately and give network calls their own
        cancellation signal: the database deadline does not cancel them, and
        rollback does not undo their external effects.
      </p>
    </div>
  );
}

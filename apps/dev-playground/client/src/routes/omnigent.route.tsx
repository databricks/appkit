import {
  Badge,
  Button,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@databricks/appkit-ui/react";
import {
  type OmnigentItem,
  type OmnigentMode,
  useOmnigentHarnesses,
  useOmnigentSession,
  useOmnigentSessions,
} from "@databricks/appkit-ui/react/beta";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/omnigent")({
  component: OmnigentRoute,
});

const MODE_LABELS: Record<OmnigentMode, string> = {
  auto: "Auto",
  ask: "Ask before changes",
  read: "Read only",
};

function text(item: OmnigentItem): string {
  return (item.data?.content ?? [])
    .map((c) => c.text ?? "")
    .join(" ")
    .trim();
}

function ItemView({ item }: { item: OmnigentItem }) {
  const d = item.data ?? {};
  if (item.type === "message") {
    const mine = d.role === "user";
    return (
      <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
            mine
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground"
          }`}
        >
          {text(item)}
        </div>
      </div>
    );
  }
  if (item.type === "function_call") {
    return (
      <div className="text-xs text-muted-foreground font-mono">
        → {d.name}({String(d.arguments ?? "")})
      </div>
    );
  }
  if (item.type === "function_call_output") {
    return (
      <pre className="text-xs bg-muted/50 rounded px-2 py-1 overflow-x-auto max-h-40">
        {String(d.output ?? "")}
      </pre>
    );
  }
  if (item.type === "error") {
    return (
      <div className="text-sm text-destructive">
        {String(d.message ?? "Error")}
      </div>
    );
  }
  return null;
}

function OmnigentRoute() {
  const options = useOmnigentHarnesses();
  const threads = useOmnigentSessions();
  const [openId, setOpenId] = useState<string | null>(null);
  const s = useOmnigentSession({ sessionId: openId });

  const [harness, setHarness] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [mode, setMode] = useState<OmnigentMode>("ask");
  const [draftText, setDraftText] = useState("");

  const current = options.harnesses.find((h) => h.id === harness);

  // Defaults once the options load; follow an opened session's settings.
  useEffect(() => {
    if (!harness && options.defaultHarness) setHarness(options.defaultHarness);
    if (!openId) setMode(options.defaultMode);
  }, [options.defaultHarness, options.defaultMode, harness, openId]);
  useEffect(() => {
    if (current && !current.models.includes(model))
      setModel(current.defaultModel ?? current.models[0] ?? "");
  }, [current, model]);
  useEffect(() => {
    if (s.session?.harness) setHarness(s.session.harness);
    if (s.session?.mode) setMode(s.session.mode);
  }, [s.session?.harness, s.session?.mode]);

  const submit = async () => {
    const message = draftText.trim();
    if (!message) return;
    setDraftText("");
    if (s.sessionId) {
      await s.send(message);
    } else {
      const id = await s.start({ harness, model, mode, message });
      setOpenId(id);
      void threads.reload();
    }
  };

  const changeMode = async (next: OmnigentMode) => {
    setMode(next);
    if (s.sessionId) await s.setMode(next);
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Omnigent
            </h1>
            <p className="text-muted-foreground mt-2">
              Claude Agent SDK, Codex, Pi and OpenAI Agents SDK sessions, with
              model calls through Unity AI Gateway and the app's tools run as
              you.
            </p>
          </div>

          {options.error && (
            <Card className="p-4 text-sm text-destructive">
              The omnigent plugin is not available: {options.error}. Start the
              playground with OMNIGENT_ENABLED=1 (and a Python 3.12 venv with
              omnigent installed).
            </Card>
          )}

          <div className="grid grid-cols-[220px_1fr] gap-4">
            <Card className="p-3 flex flex-col gap-2 h-[640px] overflow-y-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOpenId(null);
                  s.reset();
                }}
              >
                New thread
              </Button>
              {threads.sessions.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => setOpenId(t.id)}
                  className={`text-left text-sm rounded px-2 py-1 hover:bg-muted ${
                    t.id === s.sessionId ? "bg-muted font-medium" : ""
                  }`}
                >
                  <div className="truncate">{t.title || "Untitled"}</div>
                  <div className="text-xs text-muted-foreground">
                    {t.harness}
                  </div>
                </button>
              ))}
            </Card>

            <Card className="flex flex-col h-[640px]">
              <div className="flex flex-wrap items-center gap-2 border-b p-3">
                <Select
                  value={harness}
                  onValueChange={setHarness}
                  disabled={Boolean(s.sessionId)}
                >
                  <SelectTrigger className="w-[190px]">
                    <SelectValue placeholder="Harness" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.harnesses.map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.label}
                        {h.shell ? " (sandboxed)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={model}
                  onValueChange={setModel}
                  disabled={Boolean(s.sessionId)}
                >
                  <SelectTrigger className="w-[230px]">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {(current?.models ?? []).map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={mode}
                  onValueChange={(v) => changeMode(v as OmnigentMode)}
                >
                  <SelectTrigger className="w-[190px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.modes.map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {s.status && (
                  <Badge variant={s.isRunning ? "default" : "secondary"}>
                    {s.status}
                  </Badge>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
                {s.items.map((it, i) => (
                  <ItemView key={it.id ?? i} item={it} />
                ))}
                {s.draft && (
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
                    {s.draft}
                  </div>
                )}
                {s.approvals.map((a) => (
                  <Card
                    key={a.elicitation_id}
                    className="p-3 flex flex-col gap-2 border-amber-500/50"
                  >
                    <div className="text-sm font-medium">
                      Approval needed: {a.params?.message}
                    </div>
                    {a.params?.content_preview && (
                      <pre className="text-xs bg-muted/50 rounded px-2 py-1">
                        {a.params.content_preview}
                      </pre>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => s.approve(a.elicitation_id)}
                      >
                        Allow
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => s.decline(a.elicitation_id)}
                      >
                        Decline
                      </Button>
                    </div>
                  </Card>
                ))}
                {s.error && (
                  <div className="text-sm text-destructive">{s.error}</div>
                )}
              </div>

              <div className="border-t p-3 flex gap-2">
                <Textarea
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder={s.sessionId ? "Message" : "Start a thread"}
                  className="min-h-[44px] resize-none"
                />
                {s.isRunning ? (
                  <Button variant="outline" onClick={() => s.interrupt()}>
                    Stop
                  </Button>
                ) : (
                  <Button
                    onClick={() => void submit()}
                    disabled={!draftText.trim() || !harness}
                  >
                    Send
                  </Button>
                )}
              </div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
